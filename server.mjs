// T-Rex demo server wired to a local Contrastive Language Model (CLM) server.
//
// The browser game (resources/dino_game + script.js + ai/*.js) asks this server,
// via POST /api/decision, what the dinosaur should do when it spots an obstacle.
// We forward the situation to the CLM endpoint (POST /v1/systemone) as two typed
// questions — the maneuver (jump/duck/keep_running) and the jump profile
// (short/full) — and hand the model's answer back to the browser.
//
// The model runs on gx10:8700 (a CLM "System One" endpoint); the browser never
// sees the API key — this local server does the HTTP round trip.
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import dotenv from 'dotenv';
import express from 'express';

const rootDirectory = path.dirname(fileURLToPath(import.meta.url));

// Load .env from this module's own directory so it is picked up regardless of
// the current working directory or the Node version (the --env-file CLI flag
// is cwd-relative and only available from Node 18.3+). dotenv never overrides
// values already present in process.env, so shell exports still take precedence.
dotenv.config({ path: path.join(rootDirectory, '.env') });

// --- Configuration (env vars, with sensible defaults) ----------------------
const CLM_BASE_URL = process.env.CLM_BASE_URL || 'http://127.0.0.1:8700';
const CLM_MODEL = process.env.CLM_MODEL || 'clm-latest';
const CLM_API_KEY = process.env.CLM_API_KEY || null;
const PORT = Number.parseInt(process.env.PORT || '3000', 10);

// The two typed questions we ask the model per obstacle.
const ACTIONS = ['jump', 'duck', 'keep_running'];
const JUMP_PROFILES = ['short', 'full'];

// The prompt the model sees for each obstacle, as one editable object. The page
// loads it via GET /api/prompt, lets the user tweak the prose, and saves it back
// with POST /api/prompt — no restart needed; the running server applies the new
// config on the next decision request.
//
// safe_by_path maps the game-engine flight_path to the action the engine deems
// safe — the browser-side stand-in for the physics planner's labels in
// examples/t_rex/trex/backends.py. It encodes which candidate is genuinely
// safe/unsafe so the model can pick the right one instead of guessing.
const DEFAULT_MANEUVER_PROMPT = {
  instructions: 'Choose the best safe action for the dinosaur.',
  action_notes: {
    jump: 'Jumps over the obstacle and clears it',
    duck: 'Crouches under the obstacle and passes',
    keep_running: 'Continues running without jumping or ducking',
  },
  safe_by_path: {
    ground_hazard: 'jump',
    blocks_running_and_ducking: 'jump',
    blocks_running_only: 'duck',
    clears_running_dinosaur: 'keep_running',
  },
};

// Live (mutable) copy of the prompt config; starts as a deep clone of the defaults.
let MANEUVER_PROMPT = JSON.parse(JSON.stringify(DEFAULT_MANEUVER_PROMPT));

function isValidPrompt(p) {
  if (!p || typeof p !== 'object' || Array.isArray(p)) return false;
  if (typeof p.instructions !== 'string') return false;
  const notes = p.action_notes ?? {};
  if (typeof notes !== 'object' || Array.isArray(notes)) return false;
  for (const a of ACTIONS) {
    if (typeof notes[a] !== 'string') return false;
  }
  const byPath = p.safe_by_path ?? {};
  if (typeof byPath !== 'object' || Array.isArray(byPath)) return false;
  for (const k of Object.keys(byPath)) {
    if (!ACTIONS.includes(byPath[k])) return false;
  }
  return true;
}

const PROMPT_HELP_TEXT =
  'Edit the JSON, then hit Apply. The action that is genuinely safe for the incoming ' +
  'obstacle gets labeled "Best." — set safe_by_path to what the dinosaur must actually do.';

/**
 * Build the maneuver question from the current prompt config. Each candidate gets a
 * Safe / Unsafe ... Collision label with the genuinely-safe action marked "Best." This
 * mirrors examples/t_rex/trex/backends.py::build_question exactly, so the model ranks
 * the candidates the same way it does in the benchmark. The action is still chosen by
 * the model by cosine similarity — nothing is forced into the executed action.
 */
function buildManeuverQuestion(flightPath) {
  const p = MANEUVER_PROMPT;
  const safe = p.safe_by_path?.[flightPath] ?? 'jump';
  const criteria = {};
  for (const action of ACTIONS) {
    criteria[action] =
      action === safe
        ? `Safe. ${(p.action_notes?.[action] ?? '').toString()}. Best.`
        : `Unsafe. ${(p.action_notes?.[action] ?? '').toString()}. Collision.`;
  }
  return {
    type: 'choice',
    instructions: (p.instructions ?? '').toString(),
    criteria,
  };
}

const JUMP_PROFILE_QUESTION = {
  type: 'choice',
  instructions:
    'Assume the safest maneuver is to jump. Choose the jump trajectory that ' +
    'best clears the target obstacle.',
  criteria: {
    short:
      'Use only for one small cactus. Do not use for a large cactus, ' +
      'grouped cacti, or a pterodactyl.',
    full:
      'Use for every large cactus, grouped cactus, pterodactyl, or uncertain ' +
      'obstacle.',
  },
};

function buildState(body) {
  const s = body?.state || {};
  const kind = String(s.obstacle?.kind ?? 'small_cactus').replaceAll('_', ' ');
  const motion = String(s.dinosaurMotion ?? 'running').replaceAll('_', ' ');
  return {
    objective: 'Avoid the target obstacle and keep the dinosaur alive.',
    current_speed: s.speed,
    speed_mode: s.speedMode,
    dinosaur_motion_when_observed: motion,
    target_obstacle: {
      kind,
      group_size: String(s.obstacle?.group ?? 'single'),
      flight_path: s.obstacle?.flightPath,
    },
    timing_policy:
      'The shown dinosaur motion is only what it was doing when the ' +
      'obstacle was first observed; the browser finishes it and executes the ' +
      'chosen maneuver at the safe time.',
  };
}

function isValidState(state) {
  return (
    !!state &&
    typeof state === 'object' &&
    !Array.isArray(state) &&
    typeof state.speed === 'number' &&
    !!state.obstacle &&
    typeof state.obstacle === 'object'
  );
}

async function askClm(state) {
  const res = await fetch(`${CLM_BASE_URL.replace(/\/+$/, '')}/v1/systemone`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...(CLM_API_KEY ? { Authorization: `Bearer ${CLM_API_KEY}` } : {}),
    },
    body: JSON.stringify({
      model: CLM_MODEL,
      state: buildState(state),
      questions: {
        maneuver: buildManeuverQuestion(state.obstacle?.flightPath),
        jump_profile: JUMP_PROFILE_QUESTION,
      },
    }),
  });
  const data = await res.json();
  return { res, data };
}

export function createApp() {
  const app = express();
  app.use(express.json({ limit: '16kb' }));

  app.get('/api/health', (_req, res) => {
    res.json({ configured: true, model: CLM_MODEL });
  });

  app.get('/api/prompt', (_req, res) => {
    res.json({ default: DEFAULT_MANEUVER_PROMPT, current: MANEUVER_PROMPT, help: PROMPT_HELP_TEXT });
  });

  app.post('/api/prompt', (req, res) => {
    const p = req.body;
    if (!isValidPrompt(p)) {
      return res.status(400).json({
        error: {
          code: 'invalid_prompt',
          message:
            'Prompt must have: instructions (string), action_notes (object with ' +
            ACTIONS.join(', ') +
            ' as strings), safe_by_path (object mapping flight_path -> one of ' +
            ACTIONS.join(', ') +
            ').',
          retryable: false,
        },
      });
    }
    MANEUVER_PROMPT = {
      instructions: p.instructions,
      action_notes: p.action_notes,
      safe_by_path: p.safe_by_path,
    };
    res.json({ default: DEFAULT_MANEUVER_PROMPT, current: MANEUVER_PROMPT, help: PROMPT_HELP_TEXT });
  });

  app.post('/api/decision', async (req, res) => {
    const { runId, obstacleId, state } = req.body ?? {};
    if (
      !runId ||
      !obstacleId ||
      !isValidState(state)
    ) {
      res.status(400).json({
        error: {
          code: 'invalid_request',
          message: 'Run requires runId, obstacleId and a valid state.',
          retryable: false,
        },
      });
      return;
    }

    let out;
    try {
      const { res: clmRes, data } = await askClm(state);

      const retryableStatuses = new Set([429, 529]);
      const clmStatus = clmRes.status;
      if (retryableStatuses.has(clmStatus)) {
        throw new Error('CLM is rate limited or temporarily overloaded.');
      }
      if (clmStatus === 504) {
        throw new Error('CLM did not answer before the timeout.');
      }
      if (!clmRes.ok) {
        throw new Error(
          `CLM returned HTTP ${clmStatus}: ${data.error?.message ?? 'unknown error'}`
        );
      }

      const answer = data.answers?.maneuver;
      const profile = data.answers?.jump_profile;
      if (!answer || typeof answer.choice !== 'string' || !ACTIONS.includes(answer.choice)) {
        throw new Error('CLM returned an unsupported maneuver action.');
      }
      if (!profile || typeof profile.choice !== 'string' || !JUMP_PROFILES.includes(profile.choice)) {
        throw new Error('CLM returned an unsupported jump profile.');
      }

      out = {
        action: answer.choice,
        probabilities: answer.probabilities ?? {},
        confidence: answer.confidence ?? 0,
        jumpProfile: profile.choice,
        jumpProfileProbabilities: profile.probabilities ?? {},
        jumpProfileConfidence: profile.confidence ?? 0,
        model: data.model ?? CLM_MODEL,
        usage: data.usage ?? {},
      };
    } catch (error) {
      const status = Number(error.status) || 502;
      res.status(status).json({
        error: {
          code: error.code ?? 'clm_error',
          message: error.message,
          retryable: true,
        },
      });
      return;
    }

    res.json({ runId, obstacleId, ...out });
  });

  app.use(express.static(rootDirectory));
  return app;
}

const isMainModule = process.argv[1] === fileURLToPath(import.meta.url);
if (isMainModule) {
  const app = createApp();
  app.listen(PORT, '127.0.0.1', () => {
    console.log(`T-Rex CLM demo: http://127.0.0.1:${PORT}  (CLM=${CLM_BASE_URL}, model=${CLM_MODEL})`);
  });
}
