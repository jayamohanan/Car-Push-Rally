// Helper: convert CSS hex color string to Phaser hex number
function hexColor(cssColor) {
    if (typeof cssColor === 'string' && cssColor.startsWith('#')) {
        return parseInt(cssColor.substring(1), 16);
    }
    return cssColor;
}

var CONFIG = {
    // Quotes are LOAD-BEARING. Phaser passes this straight into a canvas font
    // string, and a family with a space and a digit in it fails to parse
    // unquoted — silently, falling back to the system default with no error.
    FONT_FAMILY: '"Baloo 2", sans-serif',
    FONT_WEIGHT: '600',     // the ONE weight shipped in fonts/. Every label asks
                            // for this rather than 'bold', because 'bold' means
                            // 700 — which is not in the file, so the browser
                            // SYNTHESISES it by smearing the 600 sideways. Ship
                            // an 800 file and set this to '800' for more weight.
    TEXT_COLOR: '#1A237E',

    // The canvas's clear colour. Keep it the same as the page background in
    // index.html so the letterbox bars cannot be told apart from the game.
    BACKGROUND_COLOR: '#20232b',

    DEBUG_LAYOUT: false,     // log the canvas size once at startup: [buffer]
    DEBUG_STAGE: false,      // [stage] logs: the frame size and stage chosen at
                             // boot, each reshape noticed, what holds a relayout
                             // back, and the stage it picks

    // ── The stage ─────────────────────────────────────────────────────────────
    // LANDSCAPE, AND PORTRAIT FOR PHONES (Poki's mobile players hold it upright).
    STAGE: {
        // ONLY THE WIDTH IS FIXED. Height is taken from the window's own aspect,
        // so the stage matches the screen and there are no bars to begin with —
        // a fixed 16:9 stage letterboxes on nearly every real screen.
        //
        // The clamps stop a freak window from producing an absurd stage — a very
        // wide-and-short desktop window, or a phone held upright. Beyond them you
        // get bars again, which is the correct outcome.
        W: 1920, H: 1080, MIN_RATIO: 0.45, MAX_RATIO: 0.80,
        // A WINDOW TALLER THAN WIDE gets a portrait stage instead: this wide,
        // and up to PORTRAIT_MAX_RATIO times as tall. The camera zooms out to
        // fit the curve across it (CAMERA).
        PORTRAIT_W: 1080, PORTRAIT_MAX_RATIO: 2.4,
        // false pins the stage to the H above, ignoring the window's shape.
        DERIVE_HEIGHT: true,
        // FIT      letterboxes: the whole game always visible, bars on a
        //          mismatched aspect, nothing ever cut off.
        // ENVELOP  fills the window and crops the overflow.
        MODE: 'FIT',
        // A RESHAPE — a frame whose shape would give a stage height more than
        // this share away from the current one — re-lays the game out in place
        // once the size has held still for RESHAPE_DEBOUNCE_MS (see _relayout in
        // game.js). Under it (a phone's toolbar sliding), FIT just scales.
        // -1 turns reshapes off.
        RESHAPE_TOLERANCE:   0.05,
        RESHAPE_DEBOUNCE_MS: 250,
        // While a relayout waits for whatever is mid-animation to land, time runs
        // this many times faster, so the wait is a few frames rather than a second
        // or two of the old layout on the new screen. 1 waits at normal speed.
        RELAYOUT_FAST_FORWARD: 25,
    },

    // [timing] lines in the console: how long each stage before play took, and
    // the slowest downloads. For finding where the loading time goes; turn off
    // before release.
    DEBUG_LOAD_TIMING: false,

    // ── SAVING ──────────────────────────────────────────────────────────────
    // The run is kept in the browser (localStorage) so a refresh does not lose
    // it. Written every EVERY_MS and when the page is hidden or closed.
    //   LOAD false  — ignore any save at boot (always start fresh), still write
    //   ENABLED false — no saving or loading at all
    //   Add ?newgame to the page's address to wipe the save and start over.
    SAVE: {
        ENABLED:  false,   // OFF FOR NOW: every load starts fresh, nothing is saved
        LOAD:     true,
        KEY:      'digitalCleanup.save',
        EVERY_MS: 2000,
    },

    LOADING: {
        // The backstop that lifts the loading screen anyway, so a stalled
        // download cannot lock the player out. ms
        SCREEN_TIMEOUT_MS: 20000,
    },

    // ── THE PUSH ────────────────────────────────────────────────────────────
    // All in DESIGN SPACE: a 1920 x 1080 world, scaled to fit the stage
    // (layout in game.js). y grows downward.
    ROAD: {
        // 'steps'    — an endless road of flat sections, each a step lower than
        //              the last, so the cars hop down as they go (STEPS);
        // 'straight' — one flat road, cars pushed off its far end (STRAIGHT);
        // 'dips'     — the valleys and hilltops of POINTS.
        SHAPE: 'steps',
        STEPS: {
            Y: 600,                             // the first section's height, px
            FIRST: 2600,                        // the first section's length, px
            LEN_MIN: 500, LEN_MAX: 1100,        // every later section's length, px
            DROP_MIN: 70, DROP_MAX: 120,        // how far each step goes down, px
            SEED: 7,                            // same seed, same road every run
        },
        STRAIGHT: { LENGTH: 3200, Y: 600 },   // its length and height, px
        // DIPS: ONE CONTINUOUS ROAD through these turning points, left to right, px.
        // [x, y], y down: a high start, then valley bottom and hilltop in turn,
        // and a last point partway down the far side where the road ends and
        // cars fall off. Each stretch eases in and out, so bottoms and hilltops
        // are smooth and round.
        // EACH HILLTOP HIGHER (smaller y) THAN THE ONE BEFORE: a car rolling
        // free can then never carry over the next one — it must be pushed.
        POINTS: [
            [0, 250],
            [700, 850],   [1500, 350],     // curve 1
            [2350, 750],  [3200, 250],     // curve 2
            [4050, 650],  [4900, 150],     // curve 3
            [5750, 550],  [6600, 50],      // curve 4
            [7450, 450],  [8300, -50],     // curve 5
            [8900, 400],                   // the end of the road
        ],
        ROAD_THICKNESS: 26,         // the asphalt band under the cars, px
        SKY_TOP: '#7ec8f0', SKY_BOTTOM: '#d9f1ff',
        GROUND_COLOR: '#6b8e3d',
        ROAD_COLOR: '#3b3f47',
    },

    CARS: {
        COUNT: 10,          // cars to push off (not counting the player's)
        LENGTH: 110,        // body length, px
        HEIGHT: 40,         // body height, px
        GAP: 4,             // bumper-to-bumper gap in the chain, px
        WHEEL_R: 15,        // wheel radius, px
        MASS: 1,            // each pushed car
        PLAYER_MASS: 1.5,
        PLAYER_COLOR: '#e53935',
        COLORS: ['#1e88e5', '#fdd835', '#43a047', '#8e24aa', '#fb8c00',
                 '#00acc1', '#6d4c41', '#d81b60', '#7cb342', '#5e35b1'],
        FALL_SPIN: 2.5,     // how fast a dropped car tumbles, rad/s
        START_GAP: 160,     // the player's car starts parked this far behind
                            // the train, so its first push is a visible bump, px
        START_SPACING: 60,  // gap between the pushed cars at the start, so the
                            // train gathers them one by one as it goes, px.
                            // (On a slope they roll together while settling.)
    },

    // ── ONLY THE PLAYER'S CAR HAS AN ENGINE ─────────────────────────────────
    // Everything here is looks only; none of it changes the push.
    FX: {
        // Exhaust: puffs per second, idling and at full force.
        SMOKE_IDLE: 3, SMOKE_FULL: 28,
        // STRAINING — high force, low speed — spins the player's wheels faster
        // than the road and throws dust. Spin at full strain, rad/s; dust puffs
        // per second at full strain.
        WHEEL_SPIN: 30, DUST_RATE: 30,
        // THE PUSH RIPPLE: the train's bumpers squeeze together from the back
        // when the push changes, and the squeeze travels car to car.
        RIPPLE_STIFFNESS: 400,  // how fast it travels: higher is faster, 1/s²
        RIPPLE_DAMPING: 6,      // how fast it dies away, 1/s
        RIPPLE_GAIN: 0.5,       // how much a change in speed squeezes it
        RIPPLE_SQUEEZE: 8,      // most two bumpers may overlap, px
        RIPPLE_STRETCH: 10,     // most a gap may open, px
        SPARK_SPEED: 80,        // bumpers meeting faster than this spark, px/s
    },

    PHYSICS: {
        GRAVITY: 1500,          // px/s²
        ROLL_FRICTION: 0.02,    // rolling resistance, as a share of gravity
        DRAG: 0.25,             // speed lost per second, as a share of speed
        // HOLD the pedal: force builds by FORCE_RATE per second up to FORCE_MAX.
        // LET GO: it falls by FORCE_DECAY per second to zero, and the cars on
        // the slope push the player back. Units are
        // mass x px/s²: holding one car still on a slope takes
        // MASS x GRAVITY x sin(slope angle) — 750 on a 30° slope.
        FORCE_RATE: 1500,
        FORCE_MAX: 9000,
        FORCE_DECAY: 3000,
        // THE ENGINE RUNS OUT OF PULL WITH SPEED: its force fades to nothing as
        // the player's car nears TOP_SPEED. Without it a rolling train keeps
        // gathering speed and blows through every hill. px/s
        TOP_SPEED: 450,
        SETTLE_SECONDS: 8,      // simulated before the first frame so the chain
                                // starts at rest in the valley, s
    },

    // THE VIEW fits the whole curve the player is in to the screen — zooming
    // out as far as a portrait phone needs — and glides on when the player
    // crosses a hilltop.
    CAMERA: {
        PAD: 120,       // clear space kept around the curve, world px
        MAX_ZOOM: 1.2,  // never closer than this, however much room there is
        FOLLOW_W: 2000, // on the straight road: how much of it is framed, the
                        // player's car near the left of it, px
        SPEED: 2.5,     // how quickly it catches up: share of the gap per s
    },

    // The stand-in rewarded ad shown on localhost, where the Poki SDK is absent.
    AD: {
        DURATION: 15,  // Duration of mock ad in seconds (countdown timer)
        OVERLAY_COLOR: "#000000",
        OVERLAY_ALPHA: 1.0,  // Fully opaque - blocks game view completely
        TIMER_TEXT_SIZE: '120px',
        TIMER_TEXT_COLOR: '#FFFFFF',
        // ABOVE THE COUNTDOWN — a bare number said "waiting" without saying
        // what for.
        REWARD_TEXT:       'Reward in progress',
        REWARD_TEXT_SIZE:  '40px',
        REWARD_TEXT_COLOR: '#FFFFFF',
        REWARD_TEXT_GAP:   20,   // clearance above the countdown number, px
    },
};
