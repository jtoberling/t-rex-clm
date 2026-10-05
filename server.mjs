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
// Tuned empirically against the CLM (see curl probes in /tmp/clm_test/):
//  - Game-native language ("keypress", "dodges") beats abstract phrasing.
//  - Criteria describing GEOMETRIC RELATIONSHIP (ABOVE / BELOW / intersects
//    lane) beat intent-based descriptions ("safe", "best").
//  - "Growing UP FROM THE GROUND" in the state kills the duck-under-cactus
//    attractor that plagued earlier iterations.
//  - "Way up in the sky, nowhere near the dino" triggers keep_running for
//    high-altitude pteros.
const DEFAULT_MANEUVER_PROMPT = {
  instructions:
    'Chrome T-Rex: the dino runs right automatically. Pick the keypress that dodges the obstacle.',
  action_notes: {
    jump: 'Up arrow - dino becomes airborne for a moment, tracing an arc that places it ABOVE the obstacle mid-flight',
    duck: 'Down arrow - dino flattens to the ground, reducing its height so it fits BELOW hanging obstacles while staying on the ground',
    keep_running:
      'No key - dino stays at normal running height on the ground, only works when the obstacle does not intersect the running lane at all',
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
  return true;
}

const PROMPT_HELP_TEXT =
  'Edit the JSON, then hit Apply. Describe each action neutrally; the model decides ' +
  'based on the flight_path and obstacle in the state — do NOT pre-label any action ' +
  'as "safe"/"Best", that would defeat the measurement.';

/**
 * Build the maneuver question from the current prompt config. Each candidate
 * gets only its plain description — no action is pre-labelled "Safe"/"Best" or
 * "Unsafe"/"Collision". That deliberate neutrality is what makes the CLM's pick a
 * real measurement: the state already carries the flight_path, kind, group, speed
 * and motion, so the model reasons about the situation itself instead of us
 * steering it to a pre-chosen action. The chosen action is decided purely by
 * cosine similarity — nothing is forced into the executed action.
 */
function buildManeuverQuestion(flightPath) {
  const p = MANEUVER_PROMPT;
  const criteria = {};
  for (const action of ACTIONS) {
    criteria[action] = (p.action_notes?.[action] ?? '').toString();
  }
  return {
    type: 'choice',
    instructions: (p.instructions ?? '').toString(),
    criteria,
  };
}

const JUMP_PROFILE_QUESTION = {
  type: 'choice',
  instructions: 'With up-arrow pressed, tap vs hold changes arc size:',
  criteria: {
    short:
      'Quick tap - compact arc clearing one small obstacle, tops out around 25px',
    full:
      'Longer hold - extended arc clearing tall obstacles, wide pairs, or birds, tops out 40px+',
  },
};

function buildState(state) {
  const kind = String(state?.obstacle?.kind ?? 'small_cactus');
  const group = String(state?.obstacle?.group ?? 'single');
  const flightPath = String(state?.obstacle?.flightPath ?? '');
  return {
    obstacle_scene: buildSceneText(kind, group, flightPath),
  };
}

/**
 * Translate the structured obstacle descriptor into the narrative scene text
 * that the CLM actually discriminates on. Empirically tuned:
 *  - "UP FROM THE GROUND" anchors cacti to the ground (prevents duck-attractor)
 *  - "wide pair" signals full-arc for double/triple groups
 *  - "VERY LOW, almost touching the ground" distinguishes low ptero from mid
 *  - "WAY UP HIGH, far above the dino" triggers keep_running for high ptero
 */
function buildSceneText(kind, group, flightPath) {
  const isGroup = group !== 'single';

  switch (kind) {
    case 'large_cactus':
      return isGroup
        ? 'Giant cacti growing UP FROM THE GROUND side by side. A wide, very tall wall. A quick tap will not clear their tops. Needs the full extended arc.'
        : 'Giant cactus growing UP FROM THE GROUND. Very tall and thick. A quick tap won\'t clear its top. Needs the full extended arc.';
    case 'pterodactyl':
      switch (flightPath) {
        case 'clears_running_dinosaur':
          return 'Bird hovering way up in the sky, nowhere near the dino. The dino can run straight underneath without any danger.';
        case 'blocks_running_and_ducking':
          return 'Bird skimming VERY LOW, almost touching the ground. Its wingtips drag along the dirt surface. No gap underneath - not even for a ducking dino. Only the air ABOVE its wings is empty.';
        default: // blocks_running_only (mid altitude)
          return 'Bird floating MID AIR at head height. It blocks the middle lane. The ground below it is empty. High air above it is empty.';
      }
    default: // small_cactus
      return isGroup
        ? 'Pair of cacti growing UP FROM THE GROUND side by side. Together they form a wider wall. Rooted in dirt.'
        : 'Small cactus growing UP FROM THE GROUND. It blocks the low lane. Nothing above it.';
  }
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
            ' as strings).',
          retryable: false,
        },
      });
    }
    MANEUVER_PROMPT = {
      instructions: p.instructions,
      action_notes: p.action_notes,
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
