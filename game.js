// Digital Cleanup — main game scene

class AssetManager {
    constructor(scene) {
        this.scene = scene;
        this.loading = new Map();
    }

    // AN IMAGE FETCHED AFTER PRELOAD, in the background.
    ensureImage(key, url) {
        if (this.scene.textures.exists(key)) {
            return Promise.resolve();
        }

        if (this.loading.has(key)) {
            return this.loading.get(key);
        }

        // RESOLVES EITHER WAY, and only on ITS OWN file. Listening for the next
        // 'loaderror' from ANY file would let one unrelated failed download fail
        // whichever image happened to be in flight.
        const promise = new Promise((resolve) => {
            const done = () => {
                this.scene.load.off(`filecomplete-image-${key}`, ok);
                this.scene.load.off('loaderror', fail);
                this.loading.delete(key);
                resolve();
            };
            const ok = () => done();
            const fail = (file) => { if (!file || file.key === key) done(); };
            this.scene.load.on(`filecomplete-image-${key}`, ok);
            this.scene.load.on('loaderror', fail);
            this.scene.load.image(key, url);
            this.scene.load.start();
        });

        this.loading.set(key, promise);
        return promise;
    }
}

// THE TUNABLES with their defaults filled in, read once.
let tuningCache = null;
function tuning() {
    if (tuningCache) return tuningCache;
    tuningCache = {
        road: Object.assign({
            SHAPE: 'steps', STRAIGHT: { LENGTH: 3200, Y: 600 },
            STEPS: { Y: 600, FIRST: 2600, LEN_MIN: 500, LEN_MAX: 1100, DROP_MIN: 70, DROP_MAX: 120, SEED: 7 },
            POINTS: [[0, 250], [700, 850], [1500, 350], [2100, 800]], ROAD_THICKNESS: 26,
            SKY_TOP: '#7ec8f0', SKY_BOTTOM: '#d9f1ff', GROUND_COLOR: '#6b8e3d', ROAD_COLOR: '#3b3f47',
        }, CONFIG.ROAD),
        cars: Object.assign({
            COUNT: 10, LENGTH: 110, HEIGHT: 40, GAP: 4, WHEEL_R: 15, MASS: 1, PLAYER_MASS: 1.5,
            PLAYER_COLOR: '#e53935', COLORS: ['#1e88e5'], FALL_SPIN: 2.5, START_GAP: 160, START_SPACING: 60,
        }, CONFIG.CARS),
        fx: Object.assign({
            SMOKE_IDLE: 3, SMOKE_FULL: 28, WHEEL_SPIN: 30, DUST_RATE: 30,
            RIPPLE_STIFFNESS: 400, RIPPLE_DAMPING: 6, RIPPLE_GAIN: 0.5,
            RIPPLE_SQUEEZE: 8, RIPPLE_STRETCH: 10, SPARK_SPEED: 80,
        }, CONFIG.FX),
        phys: Object.assign({
            GRAVITY: 1500, ROLL_FRICTION: 0.02, DRAG: 0.25,
            FORCE_RATE: 1500, FORCE_MAX: 9000, FORCE_DECAY: 3000, TOP_SPEED: 450, SETTLE_SECONDS: 8,
        }, CONFIG.PHYSICS),
        cam: Object.assign({ PAD: 120, MAX_ZOOM: 1.2, FOLLOW_W: 2000, SPEED: 2.5 }, CONFIG.CAMERA),
    };
    return tuningCache;
}

// ================================================================
// THE ROAD
// ================================================================
// ONE CONTINUOUS ROAD through ROAD.POINTS, sampled into a polyline with its
// running length, so a car on it is just a distance s along it. Built once,
// in world space — a reshape only changes how it is scaled onto the screen.
class Road {
    constructor(P) {
        this.xs = []; this.ys = []; this.len = [];
        let acc = 0;
        const add = (x, y) => {
            const n = this.xs.length;
            if (n) acc += Math.hypot(x - this.xs[n - 1], y - this.ys[n - 1]);
            this.xs.push(x); this.ys.push(y); this.len.push(acc);
        };
        for (let k = 0; k < P.length - 1; k++) {
            const [x0, y0] = P[k], [x1, y1] = P[k + 1];
            // EASED BOTH ENDS, so the slope is flat at every bottom and hilltop
            // — except the last stretch, which leaves its hilltop flat and is
            // still heading down where the road ends.
            const ease = k < P.length - 2 ? (u) => (1 - Math.cos(Math.PI * u)) / 2
                                          : (u) => 1 - Math.cos(Math.PI * u / 2);
            for (let x = x0; x < x1; x += 2) add(x, y0 + (y1 - y0) * ease((x - x0) / (x1 - x0)));
        }
        add(P[P.length - 1][0], P[P.length - 1][1]);
        this.total = acc;
        this.end = { x: P[P.length - 1][0], y: P[P.length - 1][1] };
        // THE CURVES: each bottom with the high points either side of it.
        this.curves = [];
        for (let k = 1; k < P.length - 1; k += 2) {
            // The last is framed out past the road's end, to see cars go off it.
            const viewRight = k + 1 === P.length - 2 ? P[P.length - 1][0] + 300 : P[k + 1][0];
            this.curves.push({ left: P[k - 1][0], right: P[k + 1][0], viewRight, bottomY: P[k][1],
                               topY: Math.min(P[k - 1][1], P[k + 1][1]), bottomS: this.sAtX(P[k][0]) });
        }
        // A STRAIGHT ROAD (two points) has no dips: it counts as one curve, the
        // train starting a little short of its middle.
        this.straight = !this.curves.length;
        if (this.straight) {
            const y = P[0][1];
            this.curves.push({ left: P[0][0], right: this.end.x, viewRight: this.end.x + 300,
                               bottomY: y, topY: y, bottomS: this.total * 0.4 });
        }
    }

    // The sample pair around v in a rising list, and how far between them.
    _find(list, v) {
        let lo = 0, hi = list.length - 1;
        if (v <= list[lo]) return { lo, hi: lo, t: 0 };
        if (v >= list[hi]) return { lo: hi, hi, t: 0 };
        while (hi - lo > 1) { const m = (lo + hi) >> 1; if (list[m] <= v) lo = m; else hi = m; }
        return { lo, hi, t: (v - list[lo]) / ((list[hi] - list[lo]) || 1) };
    }
    _lerp(list, f) { return list[f.lo] + (list[f.hi] - list[f.lo]) * f.t; }

    // The road at distance s, clamped to its two ends.
    point(s) { const f = this._find(this.len, s); return { x: this._lerp(this.xs, f), y: this._lerp(this.ys, f) }; }

    // The road never doubles back, so x alone finds a place on it.
    sAtX(x) { return this._lerp(this.len, this._find(this.xs, x)); }

    // Unit direction of travel at s.
    tangent(s) {
        const a = this.point(Math.min(s, this.total - 6) - 6), b = this.point(Math.max(s, 6) + 6);
        const d = Math.hypot(b.x - a.x, b.y - a.y) || 1;
        return { x: (b.x - a.x) / d, y: (b.y - a.y) / d };
    }

    // Which curve x is in: past the hilltop on its right is the next one.
    curveAt(x) {
        let k = 0;
        while (k < this.curves.length - 1 && x > this.curves[k].right) k++;
        return k;
    }
}

// ================================================================
// THE ENDLESS STEPS
// ================================================================
// FLAT SECTIONS, each a step lower than the last, laid out ahead as the cars
// get near. Flat, so s is simply x and the road never pulls on a car; the
// hop down a ledge is each wheel's own drop (_stepWheels). Answers the same
// questions as Road, so the push runs on it unchanged.
class StepRoad {
    constructor(S) {
        this.S = S;
        let seed = S.SEED >>> 0 || 1;
        this._rand = () => {   // mulberry32: the same road every run
            seed = (seed + 0x6D2B79F5) >>> 0;
            let t = seed;
            t = Math.imul(t ^ (t >>> 15), t | 1);
            t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
            return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
        };
        this.segs = [{ x0: 0, x1: S.FIRST, y: S.Y }];
        this.endless = true;
        this.straight = true;
        this.total = Infinity;
        this.xs = [0];
        this.end = { x: Infinity, y: S.Y };
        this.curves = [{ left: 0, right: Infinity, viewRight: Infinity, bottomY: S.Y, topY: S.Y,
                         bottomS: S.FIRST / 2 }];
    }

    _ensure(x) {
        const S = this.S;
        while (this.segs[this.segs.length - 1].x1 < x) {
            const last = this.segs[this.segs.length - 1];
            const len = S.LEN_MIN + (S.LEN_MAX - S.LEN_MIN) * this._rand();
            const drop = S.DROP_MIN + (S.DROP_MAX - S.DROP_MIN) * this._rand();
            this.segs.push({ x0: last.x1, x1: last.x1 + len, y: last.y + drop });
        }
    }

    // The sections that overlap x0..x1.
    segsIn(x0, x1) {
        this._ensure(x1);
        return this.segs.filter((sg) => sg.x1 > x0 && sg.x0 < x1);
    }

    heightAt(x) {
        if (x <= 0) return this.segs[0].y;
        this._ensure(x);
        let lo = 0, hi = this.segs.length - 1;
        while (lo < hi) { const m = (lo + hi) >> 1; if (this.segs[m].x1 <= x) lo = m + 1; else hi = m; }
        return this.segs[lo].y;
    }

    point(s) { return { x: s, y: this.heightAt(s) }; }
    tangent() { return { x: 1, y: 0 }; }
    sAtX(x) { return x; }
    curveAt() { return 0; }
}

class GameScene extends Phaser.Scene {
    constructor() { super('GameScene'); }

    // ================================================================
    // INIT
    // ================================================================
    init() {
        this.gamePaused   = false;   // frozen only while an ad plays (_setPaused)
        this.isWatchingAd = false;
        this._pointerHeld = false;
        this._keyHeld     = false;
        this._views       = [];      // everything layout() builds, for _teardown
    }

    // ================================================================
    // THE RUN
    // ================================================================
    // EVERY CAR IS ITS OWN BODY: on the road at distance s (its middle), or
    // falling off its end, or gone. Car 0 is the player's. Cars only push one
    // another where they touch.
    _resetRun() {
        const T = tuning(), C = T.cars;
        const pitch = C.LENGTH + C.GAP;
        // SPACED OUT to begin with: the train is gathered car by car.
        const spread = pitch + C.START_SPACING;
        const chain = (C.COUNT + 1) * spread - C.GAP;
        const first = Math.max(C.LENGTH / 2, this.road.curves[0].bottomS - chain / 2 + C.LENGTH / 2);
        const cars = [];
        for (let i = 0; i <= C.COUNT; i++) {
            cars.push({ i, player: !i, m: i ? C.MASS : C.PLAYER_MASS, s: first + i * spread,
                        v: 0, roll: 0, falling: null, gone: false, o: 0, ov: 0 });
        }
        // THE PLAYER STARTS PARKED, out of the physics, until the first push.
        this.run = { cars, player: cars[0], force: 0, won: false, wonAt: 0, cam: null,
                     impacts: [], spin: 0, lastPv: 0 };
        cars[0].parked = true;
        // SETTLED BEFORE IT IS SEEN, so the first frame is the train at rest in
        // the valley rather than sliding into it.
        const steps = Math.round(T.phys.SETTLE_SECONDS * 120);
        for (let i = 0; i < steps; i++) this._stepPhysics(1 / 120, true);
        for (const c of cars) c.v = 0;
        // A GAP BEHIND THE TRAIN, so the first push drives in and visibly
        // shunts it — that bump is what says "your car pushes the rest".
        const rear = Math.min(...cars.slice(1).map((c) => c.s));
        cars[0].s = Math.max(C.LENGTH / 2, rear - pitch - C.START_GAP);
        this.run.impacts = [];
    }

    // One step of every car on the road. Accelerations are px/s².
    _stepPhysics(dt, settling) {
        const T = tuning(), C = T.cars, P = T.phys, r = this.run, road = this.road, g = P.GRAVITY;
        const pitch = C.LENGTH + C.GAP, half = C.LENGTH / 2;
        const on = r.cars.filter((c) => !c.gone && !c.falling && !c.parked);
        on.sort((a, b) => a.s - b.s);
        // FREE: each car on its own — gravity along the road, and the engine.
        for (const c of on) {
            let a = g * road.tangent(c.s).y;
            if (c.player && !settling) a += r.force * Math.max(0, 1 - c.v / P.TOP_SPEED) / c.m;
            c.v += a * dt;
        }
        this._solveContacts(on, pitch, half);
        // Friction and drag slow every car alike, so a chain moving together
        // stays together — and one held still on a slope stays still.
        const fr = P.ROLL_FRICTION * g * dt, keep = 1 - P.DRAG * dt;
        for (const c of on) {
            c.v = Math.sign(c.v) * Math.max(0, Math.abs(c.v) - fr) * keep;
            c.s += c.v * dt;
            c.roll += c.v * dt / C.WHEEL_R;
        }
        // Whatever overlap the step left is pushed apart, the lighter car
        // moving more; then the left wall, and the chain shoved up off it.
        for (let it = 0; it < 4; it++) {
            for (let j = 1; j < on.length; j++) {
                const a = on[j - 1], b = on[j], d = pitch - (b.s - a.s);
                if (d > 0) { const w = a.m / (a.m + b.m); a.s -= d * (1 - w); b.s += d * w; }
            }
        }
        if (on[0].s < half) { on[0].s = half; if (on[0].v < 0) on[0].v = 0; }
        for (let j = 1; j < on.length; j++) on[j].s = Math.max(on[j].s, on[j - 1].s + pitch);
        // THE PLAYER STAYS ON THE ROAD — only the cars go off its end.
        const p = r.player;
        if (p.s > road.total - half) { p.s = road.total - half; if (p.v > 0) p.v = 0; }
        // OFF THE END: a car whose middle has passed it tips off.
        for (const c of on) if (!c.player && c.s > road.total) this._tipOff(c);
    }

    // TOUCHING CARS MAY NOT CLOSE ON EACH OTHER. Within each run of touching
    // cars, any that would catch up with the one ahead are pooled into one
    // body moving at their mass-weighted speed (momentum kept). This is what
    // lets the player push ten cars at once, and lets them push back. A car
    // against the left wall cannot move into it: the wall is a huge still mass.
    _solveContacts(on, pitch, half) {
        const SLOP = 1;
        let blocks = [];
        const flush = () => {
            for (const b of blocks) for (let j = Math.max(0, b.from); j <= b.to; j++) on[j].v = b.p / b.m;
            blocks = [];
        };
        if (on[0].s - half <= SLOP) blocks.push({ m: 1e6, p: 0, from: -1, to: -1 });
        for (let j = 0; j < on.length; j++) {
            if (j > 0 && on[j].s - on[j - 1].s - pitch > SLOP) flush();
            blocks.push({ m: on[j].m, p: on[j].m * on[j].v, from: j, to: j });
            while (blocks.length > 1) {
                const a = blocks[blocks.length - 2], b = blocks[blocks.length - 1];
                if (a.p / a.m <= b.p / b.m) break;
                // Bumpers meeting hard: noted for the sparks (_spawnFx).
                const closing = a.p / a.m - b.p / b.m;
                if (a.to >= 0 && closing > tuning().fx.SPARK_SPEED) {
                    this.run.impacts.push({ s: (on[a.to].s + on[b.from].s) / 2, speed: closing });
                }
                a.m += b.m; a.p += b.p; a.to = b.to;
                blocks.pop();
            }
        }
        flush();
    }

    // Off the end of the road, carrying its speed along the last slope.
    _tipOff(c) {
        const road = this.road;
        const p = this._carPose(road.total - 1);
        const t = road.tangent(road.total);
        const v = Math.max(c.v, 0);
        c.falling = { x: p.x, y: p.y, rot: p.rot, vx: v * t.x, vy: v * t.y, spin: tuning().cars.FALL_SPIN };
        c.v = 0;
    }

    _stepFalling(dt) {
        const g = tuning().phys.GRAVITY, r = this.run;
        for (const c of r.cars) {
            const f = c.falling;
            if (!f) continue;
            f.vy += g * dt;
            f.x += f.vx * dt; f.y += f.vy * dt;
            f.rot += f.spin * dt;
            if (f.y > this.road.end.y + 1500) {
                c.falling = null; c.gone = true;
                this._checkWin();
            }
        }
    }

    _checkWin() {
        const r = this.run;
        if (r.won || r.cars.some((c) => !c.player && !c.gone)) return;
        r.won = true;
        r.wonAt = this.time.now;
    }

    // Where a car whose middle is at s sits. TYRES ON THE ROAD: each wheel's
    // centre is one radius out from the road along the road's own normal at
    // that wheel, so it touches over a hilltop and in a hollow alike — the
    // body only tilts to sit across the two. axle is half the wheels' spread,
    // which a curve shortens a little.
    // ON THE STEPS a car c's wheels keep their own heights (c.wy), so one can
    // be dropping off a ledge while the other still rolls on top.
    _carPose(s, c) {
        const C = tuning().cars, road = this.road, d = C.LENGTH * 0.32, R = C.WHEEL_R;
        const wheel = (ws, j) => {
            const p = road.point(ws), t = road.tangent(ws);
            const y = c && c.wy ? c.wy[j] : p.y;
            return { x: p.x + t.y * R, y: y - t.x * R };
        };
        const a = wheel(s - d, 0), b = wheel(s + d, 1);
        const rot = Math.atan2(b.y - a.y, b.x - a.x);
        const lift = C.HEIGHT / 2;
        return { x: (a.x + b.x) / 2 + Math.sin(rot) * lift,
                 y: (a.y + b.y) / 2 - Math.cos(rot) * lift, rot,
                 axle: Math.hypot(b.x - a.x, b.y - a.y) / 2 };
    }

    // THE HOP DOWN A STEP. Each wheel's contact height falls under gravity
    // to the section below it and lands there, so a car going over a ledge
    // tips nose-down, then its back drops after. Looks only: the push along
    // the road does not feel it. Backed onto a higher section, a wheel just
    // sits on it.
    _stepWheels(dt) {
        if (!this.road.endless) return;
        const C = tuning().cars, g = tuning().phys.GRAVITY, d = C.LENGTH * 0.32;
        for (const c of this.run.cars) {
            if (c.gone || c.falling) continue;
            if (!c.wy) c.wy = [this.road.heightAt(c.s - d), this.road.heightAt(c.s + d)], c.wv = [0, 0];
            for (let j = 0; j < 2; j++) {
                const ground = this.road.heightAt(c.s + (j ? d : -d));
                if (c.wy[j] >= ground) { c.wy[j] = ground; c.wv[j] = 0; continue; }
                c.wv[j] += g * dt;
                c.wy[j] = Math.min(ground, c.wy[j] + c.wv[j] * dt);
            }
        }
    }

    // The curve the player is in.
    _playerCurve() {
        return this.road.curveAt(this.road.point(this.run.player.s).x);
    }

    // THE VIEW glides to fit the curve the player is in: centred on it, and
    // zoomed so all of it (and a margin) shows on this stage — far out on a
    // portrait phone, about 1:1 in landscape. The cars on a hilltop stand
    // above it, so their height is kept clear too.
    _moveCamera(dt) {
        const T = tuning(), r = this.run, { W, H } = this.layoutConfig;
        let cv = this.road.curves[this._playerCurve()];
        // ON THE STRAIGHT the view follows the player's car instead, keeping
        // it near the left with the train ahead, and stopping at the road's end.
        if (this.road.straight) {
            const px = this.road.point(r.player.s).x, fw = T.cam.FOLLOW_W;
            const left = Math.max(this.road.xs[0] - 200, Math.min(px - 300, this.road.end.x + 300 - fw));
            cv = { left, viewRight: left + fw, topY: cv.topY, bottomY: cv.bottomY };
            // On the steps, framed from the player's height down to the road
            // ahead of it.
            if (this.road.endless) {
                cv.topY = this.road.heightAt(px);
                cv.bottomY = this.road.heightAt(px + fw * 0.6);
            }
        }
        const pad = T.cam.PAD, top = cv.topY - pad - (T.cars.HEIGHT * 1.5 + T.cars.WHEEL_R * 2);
        const bw = cv.viewRight - cv.left + pad * 2, bh = cv.bottomY + pad - top;
        const tk = Math.min(W / bw, H / bh, T.cam.MAX_ZOOM);
        const tx = (cv.left + cv.viewRight) / 2, ty = (top + cv.bottomY + pad) / 2;
        if (!r.cam) { r.cam = { x: tx, y: ty, k: tk }; return; }
        const f = 1 - Math.exp(-T.cam.SPEED * dt);
        r.cam.x += (tx - r.cam.x) * f;
        r.cam.y += (ty - r.cam.y) * f;
        r.cam.k += (tk - r.cam.k) * f;
    }

    // ================================================================
    // THE ENGINE'S TELLS — looks only, nothing here moves a car
    // ================================================================
    // Only the player's car smokes and spins its wheels; the push
    // shows as a squeeze running up the train; hard bumps spark.
    _stepFx(dt) {
        if (!dt) return;
        const T = tuning(), F = T.fx, C = T.cars, P = T.phys, r = this.run, p = r.player;
        const share = r.force / P.FORCE_MAX;
        // STRAIN: force with little speed to show for it.
        const strain = p.parked ? 0 : share * (1 - Math.min(1, Math.max(0, p.v) / P.TOP_SPEED));
        r.spin += strain * F.WHEEL_SPIN * dt;
        this._stepRipple(dt, share);
        if (!this.puffs) this.puffs = [];
        const rnd = (a) => (Math.random() * 2 - 1) * a;
        const pose = this._carPose(p.s), cos = Math.cos(pose.rot), sin = Math.sin(pose.rot);
        const at = (lx, ly) => ({ x: pose.x + lx * cos - ly * sin, y: pose.y + lx * sin + ly * cos });
        // EXHAUST, out of the back and up, thicker with force.
        r.smokeT = (r.smokeT || 0) + dt * (F.SMOKE_IDLE + (F.SMOKE_FULL - F.SMOKE_IDLE) * share);
        while (r.smokeT >= 1) {
            r.smokeT--;
            const e = at(-C.LENGTH / 2 - 4, C.HEIGHT / 2 - 8), sp = 60 + 80 * share;
            this.puffs.push({ x: e.x, y: e.y, vx: -cos * sp + rnd(15), vy: -sin * sp - 30 + rnd(10),
                drag: 1.5, g: 0, age: 0, life: 0.9 + 0.4 * share, r0: 6, r1: 20 + 16 * share,
                color: 0x8d8d8d, a: 0.55 });
        }
        // DUST off the back wheel while it spins on the spot.
        r.dustT = (r.dustT || 0) + dt * F.DUST_RATE * Math.max(0, strain - 0.25) / 0.75;
        while (r.dustT >= 1) {
            r.dustT--;
            const e = at(-pose.axle, C.HEIGHT / 2 + C.WHEEL_R);
            this.puffs.push({ x: e.x, y: e.y, vx: -cos * 150 + rnd(40), vy: -sin * 150 - 60 + rnd(30),
                drag: 2, g: 0, age: 0, life: 0.6, r0: 5, r1: 18, color: 0xb08850, a: 0.6 });
        }
        // SPARKS where bumpers met hard, and a puff of grit.
        const lift = C.HEIGHT / 2 + C.WHEEL_R;
        for (const im of r.impacts) {
            const q = this.road.point(im.s), t = this.road.tangent(im.s);
            const x = q.x + t.y * lift, y = q.y - t.x * lift;
            const n = Math.min(12, 4 + Math.round(im.speed / 40));
            for (let j = 0; j < n; j++) {
                this.puffs.push({ x, y, vx: rnd(260), vy: -120 - Math.random() * 220, drag: 0, g: 1500,
                    age: 0, life: 0.3 + Math.random() * 0.2, r0: 5, r1: 1.5, color: 0xffd54f, a: 1, front: true });
            }
            this.puffs.push({ x, y, vx: 0, vy: -40, drag: 2, g: 0, age: 0, life: 0.5, r0: 8, r1: 26,
                color: 0xbdbdbd, a: 0.6, front: true });
        }
        r.impacts.length = 0;
        for (let k = this.puffs.length - 1; k >= 0; k--) {
            const f = this.puffs[k];
            f.age += dt;
            if (f.age >= f.life) { this.puffs.splice(k, 1); continue; }
            f.vy += f.g * dt;
            const keep = Math.exp(-f.drag * dt);
            f.vx *= keep; f.vy *= keep;
            f.x += f.vx * dt; f.y += f.vy * dt;
        }
    }

    // THE PUSH RIPPLE. Each car touching the train behind it gets a drawn
    // offset o along the road, sprung to its neighbours with the player's car
    // as the fixed end. A change in the player's speed shoves them all back by
    // their inertia, so the gap behind the first car closes first and the
    // squeeze runs forward car by car. While pushing, the back of the train
    // also rests a little squeezed. Drawn only: c.s is untouched.
    _stepRipple(dt, share) {
        const F = tuning().fx, C = tuning().cars, r = this.run, p = r.player;
        const pitch = C.LENGTH + C.GAP, K = F.RIPPLE_STIFFNESS;
        const on = r.cars.filter((c) => !c.gone && !c.falling && !c.parked).sort((a, b) => a.s - b.s);
        const train = [];
        const j0 = on.indexOf(p);
        if (j0 >= 0) {
            for (let j = j0 + 1; j < on.length && on[j].s - on[j - 1].s - pitch <= 1.5; j++) train.push(on[j]);
        }
        const acc = Math.max(-2000, Math.min(2000, (p.v - r.lastPv) / dt));
        r.lastPv = p.v;
        for (const c of r.cars) {
            if (!train.includes(c)) { c.o *= Math.exp(-10 * dt); c.ov = 0; }
        }
        const n = train.length;
        const rest = (k) => share * F.RIPPLE_SQUEEZE * 0.6 * (1 - k / n);   // squeeze behind car k
        const keep = Math.exp(-F.RIPPLE_DAMPING * dt);
        for (let k = 0; k < n; k++) {
            const c = train[k], back = k ? train[k - 1].o : 0;
            let f = K * (back - rest(k) - c.o);
            if (k + 1 < n) f += K * (train[k + 1].o + rest(k + 1) - c.o);
            c.ov = (c.ov + (f - acc * F.RIPPLE_GAIN) * dt) * keep;
        }
        for (let k = 0; k < n; k++) {
            const c = train[k], back = k ? train[k - 1].o : 0;
            c.o += c.ov * dt;
            const rel = c.o - back;
            if (rel < -F.RIPPLE_SQUEEZE || rel > F.RIPPLE_STRETCH) {
                c.o = back + Math.max(-F.RIPPLE_SQUEEZE, Math.min(F.RIPPLE_STRETCH, rel));
                c.ov = k ? train[k - 1].ov : 0;
            }
        }
    }

    _holding() {
        return !this.run.won && (this._pointerHeld || this._keyHeld);
    }

    // ================================================================
    // LAYOUT
    // ================================================================
    // THE STAGE'S FIGURES. Width is fixed (STAGE.W); height follows the window's
    // shape, so anything placed against the bottom or the vertical centre must
    // read H from here, never a constant.
    calculateLayout() {
        const W = this.scale.width;
        const H = this.scale.height;
        this.layoutConfig = { W, H, cx: W / 2, cy: H / 2 };
    }

    // BUILDS THE VIEW against layoutConfig. Called once from create and again
    // after every relayout, with the old view already torn down (_teardown).
    layout() {
        const { W, H } = this.layoutConfig;
        const T = tuning(), R = T.road, C = T.cars, road = this.road;
        const keep = (o) => { this._views.push(o); return o; };

        // SKY, in screen space so it fills whatever the world leaves uncovered.
        const sky = keep(this.add.graphics());
        sky.fillGradientStyle(hexColor(R.SKY_TOP), hexColor(R.SKY_TOP),
            hexColor(R.SKY_BOTTOM), hexColor(R.SKY_BOTTOM), 1);
        sky.fillRect(0, 0, W, H);

        // THE WORLD, moved and scaled under the camera by _drawRun. A new stage
        // shape snaps the camera to its new fit rather than gliding there.
        const world = keep(this.add.container(0, 0));
        this.run.cam = null;
        this.worldView = world;

        // The ground under the road, running off to the left for the side
        // margins and dropping sheer where the road ends. The endless steps
        // are drawn instead around the camera, every frame (_drawSteps).
        const ground = this.add.graphics();
        world.add(ground);
        this.groundGfx = ground;
        if (!road.endless) {
            const n = road.xs.length, left = road.xs[0] - 4000, band = R.ROAD_THICKNESS / 2;
            const deep = Math.max(...road.ys) + 3000;
            ground.fillStyle(hexColor(R.GROUND_COLOR), 1);
            ground.beginPath();
            ground.moveTo(left, road.ys[0]);
            for (let j = 0; j < n; j++) ground.lineTo(road.xs[j], road.ys[j]);
            ground.lineTo(road.end.x, deep);
            ground.lineTo(left, deep);
            ground.closePath();
            ground.fillPath();
            // The asphalt: a band hanging under the road line, so the line itself
            // is the surface the wheels touch.
            ground.lineStyle(R.ROAD_THICKNESS, hexColor(R.ROAD_COLOR), 1);
            ground.beginPath();
            ground.moveTo(left, road.ys[0] + band);
            for (let j = 0; j < n; j += 2) ground.lineTo(road.xs[j], road.ys[j] + band);
            ground.lineTo(road.end.x, road.end.y + band);
            ground.strokePath();
        }

        // Smoke and dust behind the cars; sparks (fxFront) over them.
        this.fxBack = this.add.graphics();
        world.add(this.fxBack);

        // CARS: 0 is the player's, 1..COUNT the ones to clear.
        this.carViews = [];
        for (let i = 0; i <= C.COUNT; i++) {
            const col = hexColor(i ? C.COLORS[(i - 1) % C.COLORS.length] : C.PLAYER_COLOR);
            const L = C.LENGTH, Hh = C.HEIGHT, wr = C.WHEEL_R;
            const car = this.add.container(0, 0);
            const body = this.add.graphics();
            body.fillStyle(col, 1);
            body.fillRoundedRect(-L / 2, -Hh / 2, L, Hh, 10);
            body.fillRoundedRect(-L * 0.3, -Hh / 2 - Hh * 0.55, L * 0.55, Hh * 0.7, 8);
            // NOBODY HOME in the pushed cars: dark glass, no lights. The
            // player's has lit glass, a stripe, a headlight and a tail light.
            body.fillStyle(i ? 0x37474f : 0xcfe8ff, 1);
            body.fillRoundedRect(-L * 0.24, -Hh / 2 - Hh * 0.45, L * 0.43, Hh * 0.42, 5);
            if (!i) {
                body.fillStyle(0xffffff, 1);
                body.fillRect(-L / 2 + 6, -3, L - 12, 6);
                body.fillStyle(0xfff59d, 1);
                body.fillRoundedRect(L / 2 - 10, -Hh / 2 + 5, 8, 10, 3);
                body.fillStyle(0xb71c1c, 1);
                body.fillRoundedRect(-L / 2 + 2, -Hh / 2 + 5, 6, 10, 2);
            }
            car.add(body);
            const wheels = [];
            for (const wx of [-L * 0.32, L * 0.32]) {
                const w = this.add.graphics({ x: wx, y: Hh / 2 });
                w.fillStyle(0x222222, 1); w.fillCircle(0, 0, wr);
                w.fillStyle(0x9e9e9e, 1); w.fillCircle(0, 0, wr * 0.45);
                w.fillStyle(0x222222, 1); w.fillRect(-1.5, -wr * 0.45, 3, wr * 0.9);
                car.add(w); wheels.push(w);
            }
            world.add(car);
            this.carViews.push({ car, wheels });
        }
        this.fxFront = this.add.graphics();
        world.add(this.fxFront);
        // "YOU", over the player's car until its first push.
        this.youMark = this.add.container(0, 0);
        const ym = this.add.graphics();
        ym.fillStyle(0xffffff, 1); ym.fillTriangle(-18, -10, 18, -10, 0, 12);
        this.youMark.add(ym);
        this.youMark.add(this.add.text(0, -36, 'YOU', { fontFamily: CONFIG.FONT_FAMILY,
            fontStyle: CONFIG.FONT_WEIGHT, fontSize: '44px', color: '#ffffff' })
            .setOrigin(0.5).setStroke('#1A237E', 8));
        world.add(this.youMark);

        // HUD — screen space, unscaled.
        const font = (size, color) => ({ fontFamily: CONFIG.FONT_FAMILY, fontStyle: CONFIG.FONT_WEIGHT,
            fontSize: size, color });
        keep(this.add.text(40, 26, 'FORCE', font('34px', '#1A237E')));
        this.forceBar = keep(this.add.graphics());
        // Top right in landscape; under the force bar in portrait, where the
        // two would meet.
        this.countText = keep(H > W ? this.add.text(40, 86, '', font('40px', '#1A237E'))
                                    : this.add.text(W - 40, 26, '', font('40px', '#1A237E')).setOrigin(1, 0));

        // THE PEDAL. Holding anywhere works too; this is where the thumb goes.
        this.pedal = keep(this.add.container(170, H - 160));
        const pg = this.add.graphics();
        pg.fillStyle(0x000000, 0.25); pg.fillRoundedRect(-95, -115, 190, 240, 30);
        pg.fillStyle(0x37474f, 1);    pg.fillRoundedRect(-95, -125, 190, 240, 30);
        pg.fillStyle(0x546e7a, 1);
        for (let j = 0; j < 4; j++) pg.fillRoundedRect(-70, -100 + j * 52, 140, 30, 10);
        this.pedal.add(pg);
        this.pedal.add(this.add.text(0, 150, 'HOLD TO PUSH', font('28px', '#ffffff'))
            .setOrigin(0.5).setStroke('#1A237E', 6));

        this.winText = keep(this.add.text(W / 2, H * 0.3, 'ALL CARS CLEARED!\nTap to play again',
            font('72px', '#ffffff')).setOrigin(0.5).setAlign('center').setStroke('#1A237E', 10));

        this._drawRun();
    }

    // THE OLD VIEW COMES DOWN before a relayout. Destroy here whatever layout()
    // builds; state that must survive the reshape lives elsewhere.
    _teardown() {
        for (const o of this._views) o.destroy();
        this._views = [];
        this.carViews = [];
        this.worldView = null;
    }

    // THE STEPS IN VIEW, x0..x1: each section a block of ground with the
    // asphalt on top. A section's block runs deep, so its right edge is the
    // face of the step down to the next.
    _drawSteps(x0, x1) {
        const R = tuning().road, gfx = this.groundGfx;
        gfx.clear();
        for (const sg of this.road.segsIn(x0, x1)) {
            const left = sg.x0 === 0 ? sg.x0 - 4000 : sg.x0;
            gfx.fillStyle(hexColor(R.GROUND_COLOR), 1);
            gfx.fillRect(left, sg.y, sg.x1 - left, 4000);
            gfx.fillStyle(hexColor(R.ROAD_COLOR), 1);
            gfx.fillRect(left, sg.y, sg.x1 - left, R.ROAD_THICKNESS);
        }
    }

    // The view, from the run's state.
    _drawRun() {
        const { W, H } = this.layoutConfig;
        const T = tuning(), C = T.cars, r = this.run;
        const share = r.force / T.phys.FORCE_MAX;
        if (!r.cam) this._moveCamera(0);
        const k = r.cam.k;
        this.worldView.setScale(k).setPosition(W / 2 - r.cam.x * k, H / 2 - r.cam.y * k);
        if (this.road.endless) this._drawSteps(r.cam.x - W / 2 / k - 300, r.cam.x + W / 2 / k + 300);
        for (const c of r.cars) {
            const { car, wheels } = this.carViews[c.i];
            if (c.gone) { car.setVisible(false); continue; }
            car.setVisible(true);
            if (c.falling) { car.setPosition(c.falling.x, c.falling.y).setRotation(c.falling.rot); continue; }
            const p = this._carPose(c.s + c.o, c);
            car.setPosition(p.x, p.y).setRotation(p.rot);
            wheels[0].setPosition(-p.axle, C.HEIGHT / 2);
            wheels[1].setPosition(p.axle, C.HEIGHT / 2);
            for (const w of wheels) w.setRotation(c.roll + (c.player ? r.spin : 0));
        }
        const pp = r.player;
        this.youMark.setVisible(!!pp.parked);
        if (pp.parked) {
            const q = this._carPose(pp.s);
            this.youMark.setPosition(q.x, q.y - 80 + Math.sin(this.time.now * 0.005) * 8);
        }
        for (const [gfx, front] of [[this.fxBack, false], [this.fxFront, true]]) {
            gfx.clear();
            for (const f of this.puffs || []) {
                if (!!f.front !== front) continue;
                const u = f.age / f.life;
                gfx.fillStyle(f.color, f.a * (1 - u));
                gfx.fillCircle(f.x, f.y, f.r0 + (f.r1 - f.r0) * u);
            }
        }

        const bw = 420, bh = 30, x = 150, y = 34;
        this.forceBar.clear();
        this.forceBar.fillStyle(0x000000, 0.3); this.forceBar.fillRoundedRect(x, y, bw, bh, 12);
        if (share > 0) {
            this.forceBar.fillStyle(share < 0.6 ? 0x43a047 : share < 0.9 ? 0xfdd835 : 0xe53935, 1);
            this.forceBar.fillRoundedRect(x, y, Math.max(24, bw * share), bh, 12);
        }
        const n = this.road.curves.length, curve = this._playerCurve() + 1;
        const cleared = r.cars.filter((c) => c.gone).length;
        this.countText.setText(this.road.endless ? `${Math.floor(r.player.s / 100)} m`
            : this.road.straight ? `Cleared ${cleared} / ${C.COUNT}`
            : `Curve ${curve} / ${n}    Cleared ${cleared} / ${C.COUNT}`);
        this.pedal.setScale(this._holding() ? 0.92 : 1);
        this.winText.setVisible(r.won);
    }

    // ── RESHAPE ──────────────────────────────────────────────────────────────
    // WATCHED EVERY FRAME, not on resize events. A phone reports its new width
    // and height some time after it says it has changed — later than any fixed
    // wait can be relied on — so a check fired off the event could read the OLD
    // shape and never be asked again. Reading the window each frame cannot miss
    // it. The new shape has to hold for STAGE.RESHAPE_DEBOUNCE_MS first, so a
    // window being dragged relayouts once, when it is let go.
    _pollStage() {
        const S = CONFIG.STAGE || {};
        const w = window.innerWidth, h = window.innerHeight;
        if (!w || !h) return;
        const now = performance.now();
        const want = pickStage();
        const tol = S.RESHAPE_TOLERANCE !== undefined ? S.RESHAPE_TOLERANCE : 0.05;
        const reshape = tol >= 0 && (want.width !== this.scale.width ||
            Math.abs(want.height - this.scale.height) / this.scale.height > tol);
        if (!reshape) {
            // Matches — including changed back before a relayout ran.
            this._reshapeSeenAt = 0;
            this._seenW = this._seenH = 0;
            this._relayoutPending = false;
            return;
        }
        if (w !== this._seenW || h !== this._seenH) {
            this._seenW = w; this._seenH = h;
            this._reshapeSeenAt = now;
            stageLog(`reshape seen: frame ${w} x ${h} wants ${want.width} x ${want.height}, ` +
                `game is ${this.scale.width} x ${this.scale.height}`);
            return;
        }
        const wait = S.RESHAPE_DEBOUNCE_MS !== undefined ? S.RESHAPE_DEBOUNCE_MS : 250;
        if (!this._relayoutPending && now - this._reshapeSeenAt >= wait) {
            this._relayoutPending = true;
            stageLog('relayout pending — runs once the field is settled');
        }
    }

    // What is holding the field unsettled, or null. A relayout tears the view
    // down, so it waits for anything in flight to land. Looping tweens never
    // end and are simply rebuilt by layout(), so they do not count.
    _unsettledBy() {
        if (this.isWatchingAd) return 'an ad is playing';
        const t = this.tweens.getTweens().filter((tw) => !tw.isInfinite).length;
        return t ? `${t} tween(s) running` : null;
    }

    // Time sped up while a relayout waits, and put back after.
    _fastForward(on) {
        const S = CONFIG.STAGE || {};
        const k = on ? Math.max(1, S.RELAYOUT_FAST_FORWARD !== undefined ? S.RELAYOUT_FAST_FORWARD : 25) : 1;
        if (this.tweens.timeScale !== k) this.tweens.timeScale = k;
        if (this.time.timeScale   !== k) this.time.timeScale   = k;
    }

    _relayout() {
        this._relayoutPending = false;
        this._waitWhy = undefined;
        const st = pickStage();
        stageLog(`relayout: frame ${window.innerWidth} x ${window.innerHeight} -> stage ${st.width} x ${st.height}`);
        this.scale.setGameSize(st.width, st.height);
        this.cameras.main.setSize(st.width, st.height);
        this._teardown();
        this.calculateLayout();
        this.layout();
        // Reshaped again while this ran? _pollStage picks it up next frame.
        this._reshapeSeenAt = 0;
    }

    // ── SAVING ───────────────────────────────────────────────────────────────
    // CONFIG.SAVE. So a refresh by mistake does not cost a player their run:
    // the run is written to localStorage every EVERY_MS and whenever the page
    // is hidden or closed (a reload is a close), and read back at boot.
    //
    // ONLY SETTLED FIGURES, never anything mid-animation.
    _collectSave() {
        return {
            v: SAVE_VERSION,
            t: Date.now(),
        };
    }

    _writeSave() {
        const S = CONFIG.SAVE || {};
        if (S.ENABLED === false || !this._saveReady) return;
        try { localStorage.setItem(saveKey(), JSON.stringify(this._collectSave())); }
        catch (e) { /* incognito / storage full / blocked — play on unsaved */ }
    }

    // Every EVERY_MS on the scene's clock (so not during an ad's freeze), and
    // on the page being hidden or closed — the one that catches a reload.
    _startAutosave() {
        const S = CONFIG.SAVE || {};
        if (S.ENABLED === false) return;
        this._saveReady = true;
        this.time.addEvent({ delay: S.EVERY_MS !== undefined ? S.EVERY_MS : 2000,
            loop: true, callback: () => this._writeSave() });
        if (!this._saveHooked && typeof window !== 'undefined') {
            this._saveHooked = true;
            const now = () => this._writeSave();
            window.addEventListener('pagehide', now);
            document.addEventListener('visibilitychange', () => {
                if (document.visibilityState === 'hidden') now();
            });
        }
    }

    // THE FIGURES FROM A SAVE, before anything is built from them.
    _applySave(sv) {
    }

    // ================================================================
    // PRELOAD
    // ================================================================
    preload() {
        loadMark('Phaser booted — preload starting');
        this._save = readSave();
        // REAL FIGURES FROM HERE. The page's creep stops where it is and this
        // loader's progress carries on from there.
        if (typeof window !== 'undefined' && window.__loading) {
            window.__loading.takeOver();
            loadingShown = window.__loading.value();
        }
        // The loading bar. This preload runs it up to LOAD_PRELOAD_CAP. A later
        // batch restarts the loader's own 0-1, so each takes a share of what is
        // left instead, and the bar only ever moves forward. Whatever the creep
        // reached is the floor, so the hand-over is a jump forward or nothing.
        let barFrom = Math.max(LOAD_BOOT_SHARE, loadingShown), barTo = LOAD_PRELOAD_CAP, batch = 0;
        this.load.on('start', () => {
            if (batch++ === 0) return;
            barFrom = loadingShown;
            barTo   = loadingShown + (0.97 - loadingShown) * 0.6;
        });
        this.load.on('progress', (v) => setLoadingProgress(barFrom + (barTo - barFrom) * v));
        this.load.on('complete', () => {
            if (!loadingScreenDone) loadMark(batch <= 1 ? 'preload files downloaded' : 'more art downloaded');
        });

        // SHARED ART. The list lives in assets.js, which the build also reads to
        // write the page's preload hints, so what is loaded here and what is
        // hinted cannot drift.
        for (const a of sharedAssets()) {
            if (a.type === 'json')  this.load.json(a.key, a.url);
            else if (a.frame)       this.load.spritesheet(a.key, a.url, a.frame);
            else                    this.load.image(a.key, a.url);
        }

        // A file that 404s leaves the cache entry simply absent, and whatever
        // wanted it draws nothing — which looks exactly like art that loaded and
        // was blank. Say so instead.
        this.load.on('loaderror', (file) => {
            console.error(`[load] FAILED "${file.key}" <- ${file.url} ` +
                `(${file.type}). Check the path is relative to index.html and ` +
                `that the file is actually served.`);
        });
    }

    // ================================================================
    // CREATE
    // ================================================================
    create() {
        loadMark('create: building the view');
        // The backstop for a download that never ends.
        setTimeout(finishLoadingScreen, (CONFIG.LOADING || {}).SCREEN_TIMEOUT_MS || 20000);

        if (CONFIG.DEBUG_LAYOUT) {
            const c = this.game.canvas;
            const dpr = window.devicePixelRatio || 1;
            console.log(
              `[buffer] backingStore=${c.width}x${c.height} ` +          // actual render pixels (drawing buffer)
              `cssDisplay=${c.clientWidth}x${c.clientHeight} ` +          // size shown on page (CSS px)
              `DPR=${dpr} ` +
              `physicalScreen=${Math.round(c.clientWidth*dpr)}x${Math.round(c.clientHeight*dpr)}`  // what the screen really has
            );
        }

        this.assets = new AssetManager(this);
        if (this._save) this._applySave(this._save);

        const R = tuning().road;
        this.road = R.SHAPE === 'steps' ? new StepRoad(R.STEPS)
            : new Road(R.SHAPE === 'dips' ? R.POINTS : [[0, R.STRAIGHT.Y], [R.STRAIGHT.LENGTH, R.STRAIGHT.Y]]);
        this._resetRun();

        // THE PEDAL: hold anywhere (or Space / Right / Up). After a win, a tap
        // a moment later starts a fresh run.
        this.input.on('pointerdown', () => {
            if (this.run.won) {
                if (this.time.now - this.run.wonAt > 800) this._resetRun();
                return;
            }
            this._pointerHeld = true;
        });
        const up = () => { this._pointerHeld = false; };
        this.input.on('pointerup', up);
        this.input.on('pointerupoutside', up);
        const gasKey = (ev) => ev.key === ' ' || ev.key === 'ArrowRight' || ev.key === 'ArrowUp';
        window.addEventListener('keydown', (ev) => {
            if (!gasKey(ev)) return;
            this._keyHeld = true;
            if (!pokiFirstInput) {
                pokiFirstInput = true;
                if (!this.gamePaused && !this.isWatchingAd) pokiGameplay(true);
            }
        });
        window.addEventListener('keyup', (ev) => { if (gasKey(ev)) this._keyHeld = false; });
        window.addEventListener('blur', () => { this._keyHeld = false; this._pointerHeld = false; });

        this.calculateLayout();
        this.layout();
        this._startAutosave();

        // POKI: gameplayStart ON THE PLAYER'S FIRST INPUT — the first tap or
        // click anywhere.
        this.input.once('pointerdown', () => {
            pokiFirstInput = true;
            if (!this.gamePaused && !this.isWatchingAd) pokiGameplay(true);
        });

        // Everything the opening view needs is up.
        finishLoadingScreen();
    }

    // ================================================================
    // PAUSE AND ADS
    // ================================================================
    _setPaused(on) {
        if (this.gamePaused === on) return;
        this.gamePaused = on;
        // Poki's gameplay events are sent by the CALLERS (the ads), in the
        // order each needs them.
        if (on) { this.tweens.pauseAll(); this.anims.pauseAll(); }
        else    { this.tweens.resumeAll(); this.anims.resumeAll(); }
        this.time.paused = on;                 // every timer and delayedCall
    }

    // A REWARDED AD. onReward runs only if it was watched to the end; onFail
    // when there was no ad to show (or it was skipped). On localhost, where
    // the Poki SDK times out, a mock ad stands in.
    showRewardedAd(onReward, onFail) {
        if (this.isWatchingAd) return;  // Prevent multiple ad triggers
        if (pokiReady) {
            this.isWatchingAd = true;
            this._setPaused(true);
            pokiGameplay(false);
            pokiRewardedBreak().then((ok) => {
                this.isWatchingAd = false;
                this._setPaused(false);
                if (pokiFirstInput) pokiGameplay(true);
                if (ok) { if (onReward) onReward(); }
                else if (onFail) onFail();
            });
            return;
        }
        if (isLocalDev()) { this.showMockAd(() => { if (onReward) onReward(); }); return; }
        if (onFail) onFail();
    }

    showMockAd(onComplete) {
        this.isWatchingAd = true;  // Block all interactions during ad
        // THE WORLD STOPS FOR THE AD — tweens mid-flight, every timer — and
        // picks up exactly where it was once the ad is over, the way Poki
        // requires.
        this._setPaused(true);
        pokiGameplay(false);
        const W = this.cameras.main.width;
        const H = this.cameras.main.height;
        const A = CONFIG.AD;

        // Create overlay
        const overlay = this.add.rectangle(W / 2, H / 2, W, H,
            parseInt(A.OVERLAY_COLOR.substring(1), 16), A.OVERLAY_ALPHA)
            .setDepth(10000)
            .setInteractive();  // Block clicks from passing through overlay
        this._shadePage(A.OVERLAY_COLOR, A.OVERLAY_ALPHA, 0);

        // Create countdown timer text in center
        const timerText = this.add.text(W / 2, H / 2, `${A.DURATION}`, {
            fontSize: A.TIMER_TEXT_SIZE,
            fontFamily: CONFIG.FONT_FAMILY,
            color: A.TIMER_TEXT_COLOR,
            fontStyle: CONFIG.FONT_WEIGHT,
        }).setOrigin(0.5).setDepth(10001);

        // "REWARD IN PROGRESS", measured off the number's own TOP edge, not the
        // screen's centre line, so the number cannot run through it.
        const rewardText = this.add.text(W / 2,
                timerText.y - timerText.height / 2
                    - (A.REWARD_TEXT_GAP !== undefined ? A.REWARD_TEXT_GAP : 20),
                A.REWARD_TEXT || 'Reward in progress', {
            fontSize: A.REWARD_TEXT_SIZE || '40px',
            fontFamily: CONFIG.FONT_FAMILY,
            color: A.REWARD_TEXT_COLOR || '#FFFFFF',
            fontStyle: CONFIG.FONT_WEIGHT,
        }).setOrigin(0.5, 1).setDepth(10001);

        // Countdown from AD.DURATION to 0. ON THE BROWSER'S CLOCK, not the
        // scene's: the scene's is the one stopped for the ad, and a countdown
        // on it would never reach zero.
        let timeLeft = A.DURATION;
        const countdown = window.setInterval(() => {
            if (!overlay.scene) { window.clearInterval(countdown); return; }   // scene gone
            timeLeft--;
            if (timeLeft > 0) {
                timerText.setText(`${timeLeft}`);
            } else {
                window.clearInterval(countdown);
                this._shadePage(null);
                overlay.destroy();
                rewardText.destroy();
                timerText.destroy();
                this.isWatchingAd = false;  // Re-enable interactions
                this._setPaused(false);     // the world carries on from where it stopped
                if (pokiFirstInput) pokiGameplay(true);
                onComplete();
            }
        }, 1000);
    }

    // THE PAGE AROUND THE CANVAS takes on a shade too, so the letterbox bars
    // darken with an overlay instead of staying bright around it. null puts
    // the page's own colour back.
    _shadePage(color, alpha, ms) {
        if (typeof document === 'undefined') return;
        const ground = CONFIG.BACKGROUND_COLOR;
        let css = '';
        if (color) {
            const g = hexColor(ground), c = hexColor(color), a = Math.max(0, Math.min(1, alpha));
            const mix = (sh) => Math.round(((g >> sh) & 255) * (1 - a) + ((c >> sh) & 255) * a);
            css = `rgb(${mix(16)}, ${mix(8)}, ${mix(0)})`;
        }
        for (const el of [document.documentElement, document.body]) {
            if (!el) continue;
            el.style.transition = ms > 0 ? `background-color ${ms}ms linear` : '';
            el.style.backgroundColor = css || ground;
        }
    }

    // ================================================================
    // UPDATE
    // ================================================================
    update(time, delta) {
        if (!this._firstFrameMarked) { this._firstFrameMarked = true; loadMark('first frame — create() finished'); }
        if (this.gamePaused) return;
        this._pollStage();
        if (this._relayoutPending) {
            const why = this._unsettledBy();
            if (why !== this._waitWhy) { this._waitWhy = why; if (why) stageLog(`relayout waiting: ${why}`); }
            if (!why) { this._fastForward(false); this._relayout(); }
            else this._fastForward(true);
        } else {
            this._fastForward(false);   // reshaped back before it ran
        }

        // THE PUSH, in fixed small steps so a slow frame cannot tunnel a car
        // through a lip or jolt the chain. Held, the force builds; let go, it
        // drains away and the cars on the slope push back.
        const P = tuning().phys, r = this.run;
        const dt = Math.min(delta, 50) / 1000;
        if (this._holding()) r.force = Math.min(P.FORCE_MAX, r.force + P.FORCE_RATE * dt);
        else r.force = Math.max(0, r.force - P.FORCE_DECAY * dt);
        const n = Math.max(1, Math.ceil(dt * 120));
        for (let i = 0; i < n; i++) this._stepPhysics(dt / n);
        if (r.player.parked && r.force > 0) r.player.parked = false;   // the first push
        this._stepWheels(dt);
        this._stepFalling(dt);
        this._stepFx(dt);
        this._moveCamera(dt);
        if (this.worldView) this._drawRun();
    }
}

// ================================================================
// PHASER CONFIG + BOOT
// ================================================================
// [stage] console lines — CONFIG.DEBUG_STAGE.
function stageLog(msg) {
    if (typeof CONFIG !== 'undefined' && CONFIG.DEBUG_STAGE) console.log(`[stage] ${msg}`);
}

// ── THE STAGE ──────────────────────────────────────────────────────────────
// One fixed render width (a narrower one for a portrait window), scaled by
// the browser to fill whatever window it lands in. The height is taken from the window's shape — at boot, and again
// when it changes shape enough (STAGE.RESHAPE_TOLERANCE — see _pollStage).
// That does not restart anything: the scene takes the new size and re-lays
// itself out in place (see _relayout). A smaller resize is just the browser
// scaling this stage.
function pickStage() {
    const S = (typeof CONFIG !== 'undefined' && CONFIG.STAGE) || {};
    const winW = window.innerWidth  || 1280;
    const winH = window.innerHeight || 720;
    // PORTRAIT: a narrower stage, as tall as the window's shape asks.
    if (S.DERIVE_HEIGHT !== false && winH > winW) {
        const W = S.PORTRAIT_W || 1080;
        const ratio = Math.min(winH / winW, S.PORTRAIT_MAX_RATIO || 2.4);
        return { width: W, height: Math.round(W * ratio) };
    }
    const W = S.W || 1920;
    let height = S.H || 1080;
    if (S.DERIVE_HEIGHT !== false) {
        const ratio = Math.min(Math.max(winH / winW, S.MIN_RATIO || 0.3), S.MAX_RATIO || 3);
        height = Math.round(W * ratio);
    }
    return { width: W, height };
}
const STAGE = pickStage();
stageLog(`boot: frame ${window.innerWidth} x ${window.innerHeight} -> stage ${STAGE.width} x ${STAGE.height}`);

const GAME_WIDTH  = STAGE.width;
const GAME_HEIGHT = STAGE.height;

const config = {
    type: Phaser.AUTO,
    parent: 'game-container',
    // The canvas's own clear colour — matched to the page behind it so the
    // two cannot be told apart.
    backgroundColor: CONFIG.BACKGROUND_COLOR,
    scene: [GameScene],
    scale: {
        // FIT/ENVELOP means Phaser owns the canvas's DISPLAY size and keeps it
        // in step with the window on its own — no resize listener of ours, and
        // no restart. The game's own coordinate space stays GAME_WIDTH x
        // GAME_HEIGHT until a relayout changes it.
        mode: (Phaser.Scale[(CONFIG.STAGE || {}).MODE] || Phaser.Scale.FIT),
        autoCenter: Phaser.Scale.CENTER_BOTH,   // bars split evenly, not all on one side
        width:  GAME_WIDTH,
        height: GAME_HEIGHT,
        expandParent: true,
    },
    render: { antialias: true, pixelArt: false, roundPixels: false },
    // HOW MANY FILES DOWNLOAD AT ONCE. Phaser's own default is 32 — except on
    // Android, where it drops to 6. Poki's Inspector reports itself as an
    // Android phone, so a server slow to answer each file turned the opening
    // load into queues. Set here, it is 32 everywhere.
    //
    // IMAGES AS PLAIN <img> LOADS, not XHR. The build's index.html carries
    // <link rel="preload" as="image"> hints, and the browser only hands that
    // early download to a request of the SAME kind — an image load,
    // CORS-anonymous. Phaser's default XHR fetch would download every hinted
    // image a second time.
    loader: { maxParallelDownloads: 32, imageLoadType: 'HTMLImageElement', crossOrigin: 'anonymous' },
};

// The font has to be IN HAND before the game starts, not merely declared.
// Phaser renders each Text into its own canvas texture the moment it is created
// and never re-renders it, so a label built before the font arrives keeps the
// fallback for the life of the scene. document.fonts.load() both triggers the
// fetch and tells us when it is done.
//
// It resolves rather than rejects on failure: a missing font is not a reason
// to withhold the game.
function waitForFont() {
    if (!document.fonts || !document.fonts.load) return Promise.resolve();
    const f = (CONFIG.FONT_FAMILY || '').split(',')[0].trim();
    if (!f) return Promise.resolve();
    return document.fonts.load(`${CONFIG.FONT_WEIGHT || '600'} 16px ${f}`)
        .catch(() => {})
        .then(() => document.fonts.ready)
        .catch(() => {});
}

// ── Load timing ──────────────────────────────────────────────────────────────
// Where the time before play goes, stage by stage, printed as [timing] lines.
// performance.now() counts from the moment the page was opened, so each mark's
// first number is "ms since page open" — the same clock Poki's loading time
// runs on. The "+" figure is the gap since the mark before.
const loadMarks = [];
function loadMark(label) {
    if (!CONFIG.DEBUG_LOAD_TIMING || typeof performance === 'undefined') return;
    const t = Math.round(performance.now());
    const prev = loadMarks.length ? loadMarks[loadMarks.length - 1].t : 0;
    loadMarks.push({ label, t });
    console.log(`[timing] ${String(t).padStart(6)}ms  (+${t - prev}ms)  ${label}`);
}
// Once, when loading finishes: the page's own download, then the network
// requests that took longest. A request's time includes waiting its turn, so a
// long list of files all starting late points at queuing, not at size.
function loadTimingReport() {
    if (!CONFIG.DEBUG_LOAD_TIMING || typeof performance === 'undefined' || !performance.getEntriesByType) return;
    const nav = performance.getEntriesByType('navigation')[0];
    if (nav) {
        console.log(`[timing] page HTML: request sent at ${Math.round(nav.requestStart)}ms, ` +
            `downloaded by ${Math.round(nav.responseEnd)}ms, parsed by ${Math.round(nav.domContentLoadedEventEnd)}ms`);
    }
    const res = performance.getEntriesByType('resource');
    const short = (u) => String(u).split('?')[0].split('/').slice(-2).join('/');
    const kb = (r) => r.transferSize ? `${(r.transferSize / 1024).toFixed(0)}KB` : 'size n/a';
    console.log(`[timing] ${res.length} requests before loading finished. Slowest:`);
    for (const r of [...res].sort((a, b) => b.duration - a.duration).slice(0, 10)) {
        console.log(`[timing]    ${String(Math.round(r.duration)).padStart(5)}ms  ` +
            `from ${Math.round(r.startTime)}ms to ${Math.round(r.responseEnd)}ms  ${kb(r)}  ${short(r.name)}`);
    }
}

// The loading screen in index.html. The time before Phaser boots (font, Poki
// init) takes the first sliver of the bar; the asset loader fills the rest.
const LOAD_BOOT_SHARE  = 0.1;
const LOAD_PRELOAD_CAP = 0.85;   // the rest is create() building the view
let loadingScreenDone = false;
let loadingShown = 0;            // never goes back: a batch added mid-load grows
                                 // the total, which would otherwise pull it back
function setLoadingProgress(v) {
    if (loadingScreenDone || typeof window === 'undefined') return;
    // THE PAGE OWNS THE BAR (see the script in index.html): it starts moving on
    // the first paint, long before this file exists, and it refuses to go
    // backwards. Everything here is a request to move it forward.
    const bar = window.__loading;
    if (!bar) return;
    bar.set(Math.max(0, Math.min(1, v)));
    loadingShown = bar.value();
}
function finishLoadingScreen() {
    if (loadingScreenDone) return;
    loadMark('opening view built — LOADING FINISHED (this is what Poki times)');
    loadTimingReport();
    setLoadingProgress(1);
    loadingScreenDone = true;
    // gameplayStart waits for the player's FIRST INPUT, not the load — Poki's
    // rule. See the scene's first pointerdown (create) and pokiFirstInput.
    pokiCall('gameLoadingFinished');
    const screen = typeof document !== 'undefined' && document.getElementById('loading-screen');
    if (!screen) return;
    // A beat at 100% before fading, so the full bar is actually seen — create()
    // blocks the page while it builds, and a fade started now would freeze.
    setTimeout(() => {
        screen.classList.add('done');
        setTimeout(() => screen.remove(), 500);
    }, 250);
}

// ── Poki SDK ─────────────────────────────────────────────────────────────────
// Every call goes through here, because the SDK is optional at runtime: an ad
// blocker removes it, and a page served anywhere but Poki may not have it. A
// missing or throwing SDK must never cost the player the game.
let pokiReady = false;
function pokiCall(fn) {
    if (!pokiReady) return;
    try { window.PokiSDK[fn](); } catch (e) { console.warn(`[poki] ${fn} failed`, e); }
}
// Start/stop are sent only on a real change, so a stray repeat from either
// side never reaches Poki as a double event.
let pokiPlaying = false;
function pokiGameplay(on) {
    if (pokiPlaying === on) return;
    pokiPlaying = on;
    pokiCall(on ? 'gameplayStart' : 'gameplayStop');
}
// The player's first input has happened — gameplayStart may be sent. Before
// it, nothing (not even the end of an ad) may start gameplay.
let pokiFirstInput = false;

// A REWARDED BREAK. Resolves true only if Poki says the ad was watched.
function pokiRewardedBreak() {
    if (!pokiReady) return Promise.resolve(false);
    try {
        return Promise.resolve(window.PokiSDK.rewardedBreak(() => {}))
            .then((ok) => !!ok).catch(() => false);
    } catch (e) { console.warn('[poki] rewardedBreak failed', e); return Promise.resolve(false); }
}

// ── The save, as stored ─────────────────────────────────────────────────────
// Bump SAVE_VERSION if the shape changes incompatibly: an older save is then
// ignored (a fresh start) rather than misread.
const SAVE_VERSION = 1;
function saveKey() { return ((typeof CONFIG !== 'undefined' && CONFIG.SAVE) || {}).KEY || 'digitalCleanup.save'; }

// The stored run — or null for a fresh start: none saved, loading switched
// off, storage blocked, or anything malformed. A bad save must never stop the
// game from starting. Check and tidy each field here as the save grows.
function readSave() {
    const S = (typeof CONFIG !== 'undefined' && CONFIG.SAVE) || {};
    if (S.ENABLED === false || S.LOAD === false) return null;
    try {
        // ?newgame in the page's address wipes the save — a fresh run to test.
        if (typeof location !== 'undefined' && /[?&]newgame\b/.test(location.search)) {
            localStorage.removeItem(saveKey());
            return null;
        }
        const raw = localStorage.getItem(saveKey());
        if (!raw) return null;
        const d = JSON.parse(raw);
        if (!d || d.v !== SAVE_VERSION) return null;
        return d;
    } catch (e) {
        return null;
    }
}

// Running on the developer's own machine — where the mock ad stands in.
function isLocalDev() {
    if (typeof location === 'undefined') return false;
    return location.protocol === 'file:' || /^(localhost|127\.0\.0\.1|\[::1\]|0\.0\.0\.0)$/.test(location.hostname);
}

// THE PARENT PAGE MUST NOT SCROLL under the game — arrow keys, space and the
// mouse wheel would otherwise scroll Poki's page around it. Poki's rule.
if (typeof window !== 'undefined') {
    window.addEventListener('keydown', (ev) => {
        if (['ArrowDown', 'ArrowUp', 'ArrowLeft', 'ArrowRight', ' '].includes(ev.key)) ev.preventDefault();
    });
    window.addEventListener('wheel', (ev) => ev.preventDefault(), { passive: false });
}

// Resolves either way. The timeout is there so a hung init can never hold the
// game on the loading screen — Poki would rather lose a metric than a player.
function initPoki() {
    if (typeof window === 'undefined' || !window.PokiSDK) {
        console.warn('[poki] SDK not present — running without it');
        loadMark('Poki SDK not present');
        return Promise.resolve();
    }
    let settled = false;
    const init = window.PokiSDK.init()
        .then(() => { pokiReady = true; loadMark('Poki SDK ready'); })
        .catch((e) => { console.warn('[poki] init failed — running without it', e); loadMark('Poki SDK init FAILED'); })
        .finally(() => { settled = true; });
    const cap = new Promise((r) => setTimeout(() => {
        if (!settled) loadMark('Poki SDK still not ready after 4000ms — TIMED OUT, carrying on');
        r();
    }, 4000));
    return Promise.race([init, cap]);
}

if (typeof window !== 'undefined') {
    loadMark('game script running (page, Phaser and Poki SDK scripts are in)');
    setLoadingProgress(LOAD_BOOT_SHARE * 0.4);
    Promise.all([
        waitForFont().then(() => loadMark('font ready')),
        initPoki(),
    ]).then(() => {
        loadMark('boot checks done — starting Phaser');
        setLoadingProgress(LOAD_BOOT_SHARE);
        new Phaser.Game(config);
    });
}
