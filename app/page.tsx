"use client";

import { useEffect, useRef, useState, useCallback } from "react";
import Pusher, { Channel } from "pusher-js";

type User = "shehzaad" | "maggie";

type Tap = {
  id: string;
  user: User;
  x: number;
  y: number;
  bornAt: number; // local performance.now()
};

type Hold = {
  id: string;
  user: User;
  x: number;
  y: number;
  startedAt: number;
  lastMoveAt: number;
  ending?: boolean;
  endedAt?: number;
  trail: Array<{ x: number; y: number; t: number }>;
};

type Particle = {
  x: number;
  y: number;
  vx: number;
  vy: number;
  life: number;
  max: number;
  color: string;
  size: number;
  kind: "heart" | "spark";
  gravity?: number;
  rot?: number;
  spin?: number;
};

type PushSub = PushSubscriptionJSON;

const PALETTE = {
  shehzaad: {
    name: "Shehzaad",
    vibe: "epic",
    primary: [0, 240, 255],
    secondary: [160, 32, 255],
    accent: [255, 255, 255],
    bg1: "#0a0015",
    bg2: "#00081a",
    buttonBg: "linear-gradient(135deg, #00f0ff 0%, #a020ff 100%)",
    pushEmoji: "⚡",
  },
  maggie: {
    name: "Maggie",
    vibe: "sparkle",
    primary: [255, 79, 168],
    secondary: [255, 182, 193],
    accent: [255, 240, 245],
    bg1: "#1a0010",
    bg2: "#2a0020",
    buttonBg: "linear-gradient(135deg, #ff4fa8 0%, #ffb6c1 100%)",
    pushEmoji: "💕",
  },
} as const;

const HOLD_THRESHOLD_MS = 180;
const MOVE_MIN_INTERVAL_MS = 80;
const MOVE_MIN_DELTA = 0.005;
const HOLD_STALE_MS = 3000;
const DECAY_MS = 600;
const TAP_LIFE_MS = 650;
const CRASH_INITIAL_COOLDOWN = 400;
const CRASH_TRICKLE_COOLDOWN = 150;
const BOND_THRESHOLD_MS = 5000;
const BOND_LABEL_CYCLE_MS = 2800;
const BOND_LABELS = [
  "locked in",
  "fused",
  "+5000 aura",
  "bonded",
  "ripplemaxxing",
  "clav maxxing",
  "mogging together",
];
const CHANNEL = "ripple-room";

const uid = () => Math.random().toString(36).slice(2, 10) + Date.now().toString(36);

function urlBase64ToUint8Array(base64String: string) {
  const padding = "=".repeat((4 - (base64String.length % 4)) % 4);
  const base64 = (base64String + padding).replace(/-/g, "+").replace(/_/g, "/");
  const rawData = atob(base64);
  const output = new Uint8Array(rawData.length);
  for (let i = 0; i < rawData.length; i++) output[i] = rawData.charCodeAt(i);
  return output;
}

export default function Home() {
  const [user, setUser] = useState<User | null>(null);
  const [connected, setConnected] = useState(false);
  const [pushStatus, setPushStatus] = useState<"idle" | "pending" | "granted" | "denied" | "unsupported">("idle");
  const [isStandalone, setIsStandalone] = useState(false);
  const [showInstallHint, setShowInstallHint] = useState(false);

  const canvasRef = useRef<HTMLCanvasElement>(null);
  const userRef = useRef<User | null>(null);

  const myHoldRef = useRef<Hold | null>(null);
  const theirHoldRef = useRef<Hold | null>(null);
  const decayingHoldsRef = useRef<Hold[]>([]);
  const tapsRef = useRef<Tap[]>([]);
  const particlesRef = useRef<Particle[]>([]);

  // Pointer session tracking
  const pointerSessionRef = useRef<{
    pointerId: number;
    startedAt: number; // perf.now
    x: number;
    y: number;
    holdId: string | null; // set when we cross the threshold
    lastSendAt: number;
    lastSentX: number;
    lastSentY: number;
  } | null>(null);

  // Crash + bond
  const lastCrashAtRef = useRef<number>(0);
  const overlapActiveRef = useRef<boolean>(false);
  const overlapStartedAtRef = useRef<number | null>(null);
  const bondedRef = useRef<{ since: number; centerX: number; centerY: number } | null>(null);

  // Push + Pusher
  const channelRef = useRef<Channel | null>(null);
  const ownSubRef = useRef<PushSub | null>(null);
  const otherSubRef = useRef<PushSub | null>(null);
  const lastSubBroadcastRef = useRef<number>(0);
  const lastPushSentRef = useRef<number>(0);

  useEffect(() => {
    const saved = (typeof window !== "undefined" && localStorage.getItem("ripple-user")) as User | null;
    if (saved === "shehzaad" || saved === "maggie") setUser(saved);
    try {
      const s = localStorage.getItem("ripple-other-sub");
      if (s) otherSubRef.current = JSON.parse(s);
    } catch {}
    if (typeof window !== "undefined") {
      const standalone =
        window.matchMedia("(display-mode: standalone)").matches ||
        // @ts-expect-error iOS-specific
        window.navigator.standalone === true;
      setIsStandalone(standalone);
    }
  }, []);

  useEffect(() => {
    userRef.current = user;
  }, [user]);

  const choose = (u: User) => {
    localStorage.setItem("ripple-user", u);
    setUser(u);
  };
  const resetUser = () => {
    localStorage.removeItem("ripple-user");
    setUser(null);
  };

  // Service worker
  useEffect(() => {
    if (!user) return;
    if (typeof window === "undefined" || !("serviceWorker" in navigator)) {
      setPushStatus("unsupported");
      return;
    }
    navigator.serviceWorker
      .register("/sw.js")
      .then(async () => {
        const reg = await navigator.serviceWorker.ready;
        const existing = await reg.pushManager.getSubscription();
        if (existing) {
          ownSubRef.current = existing.toJSON() as PushSub;
          setPushStatus("granted");
        } else if (Notification.permission === "denied") {
          setPushStatus("denied");
        }
      })
      .catch(() => setPushStatus("unsupported"));
  }, [user]);

  const enablePush = async () => {
    try {
      if (!("serviceWorker" in navigator) || !("PushManager" in window)) {
        setPushStatus("unsupported");
        return;
      }
      const pub = process.env.NEXT_PUBLIC_VAPID_PUBLIC_KEY;
      if (!pub) return;
      setPushStatus("pending");
      const permission = await Notification.requestPermission();
      if (permission !== "granted") {
        setPushStatus(permission === "denied" ? "denied" : "idle");
        return;
      }
      const reg = await navigator.serviceWorker.ready;
      const existing = await reg.pushManager.getSubscription();
      const sub =
        existing ||
        (await reg.pushManager.subscribe({
          userVisibleOnly: true,
          applicationServerKey: urlBase64ToUint8Array(pub),
        }));
      ownSubRef.current = sub.toJSON() as PushSub;
      setPushStatus("granted");
      broadcastOwnSub();
    } catch {
      setPushStatus("idle");
    }
  };

  const broadcastOwnSub = useCallback(() => {
    const me = userRef.current;
    const sub = ownSubRef.current;
    if (!me || !sub) return;
    const now = Date.now();
    if (now - lastSubBroadcastRef.current < 5000) return;
    lastSubBroadcastRef.current = now;
    fetch("/api/broadcast-sub", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ user: me, sub }),
    }).catch(() => {});
  }, []);

  // Pusher
  useEffect(() => {
    if (!user) return;
    const key = process.env.NEXT_PUBLIC_PUSHER_KEY;
    const cluster = process.env.NEXT_PUBLIC_PUSHER_CLUSTER;
    if (!key || !cluster) return;
    const pusher = new Pusher(key, { cluster });
    const channel = pusher.subscribe(CHANNEL);
    channelRef.current = channel;

    channel.bind("pusher:subscription_succeeded", () => {
      setConnected(true);
      if (ownSubRef.current) broadcastOwnSub();
    });
    pusher.connection.bind("state_change", (s: { current: string }) => {
      setConnected(s.current === "connected");
    });

    channel.bind("tap", (data: { id: string; user: User; x: number; y: number }) => {
      if (data.user === userRef.current) return;
      tapsRef.current.push({
        id: data.id,
        user: data.user,
        x: data.x,
        y: data.y,
        bornAt: performance.now(),
      });
    });

    channel.bind(
      "hold",
      (data: {
        action: "start" | "move" | "end";
        id: string;
        user: User;
        x?: number;
        y?: number;
      }) => {
        if (data.user === userRef.current) return;
        if (data.action === "start") {
          const now = performance.now();
          theirHoldRef.current = {
            id: data.id,
            user: data.user,
            x: data.x ?? 0.5,
            y: data.y ?? 0.5,
            startedAt: now,
            lastMoveAt: now,
            trail: [{ x: data.x ?? 0.5, y: data.y ?? 0.5, t: now }],
          };
        } else if (data.action === "move") {
          const cur = theirHoldRef.current;
          if (!cur || cur.id !== data.id) return;
          const now = performance.now();
          cur.x = data.x ?? cur.x;
          cur.y = data.y ?? cur.y;
          cur.lastMoveAt = now;
          cur.trail.push({ x: cur.x, y: cur.y, t: now });
          if (cur.trail.length > 8) cur.trail.shift();
        } else if (data.action === "end") {
          const cur = theirHoldRef.current;
          if (!cur || cur.id !== data.id) return;
          cur.ending = true;
          cur.endedAt = performance.now();
          decayingHoldsRef.current.push(cur);
          theirHoldRef.current = null;
        }
      }
    );

    channel.bind("push-sub", (data: { user: User; sub: PushSub }) => {
      if (data.user === userRef.current) return;
      otherSubRef.current = data.sub;
      try {
        localStorage.setItem("ripple-other-sub", JSON.stringify(data.sub));
      } catch {}
      if (ownSubRef.current) broadcastOwnSub();
    });

    return () => {
      channel.unbind_all();
      pusher.unsubscribe(CHANNEL);
      pusher.disconnect();
      channelRef.current = null;
    };
  }, [user, broadcastOwnSub]);

  // Push notification fire (local side)
  const sendPushMaybe = useCallback(async () => {
    const sub = otherSubRef.current;
    const me = userRef.current;
    if (!sub || !me) return;
    const now = Date.now();
    if (now - lastPushSentRef.current < 60_000) return;
    lastPushSentRef.current = now;
    const pal = PALETTE[me];
    const payload = {
      title: `${pal.name}'s on ripple ${pal.pushEmoji}`,
      body: "tap to ripple back",
      tag: `ripple-${me}`,
      url: "/",
    };
    try {
      await fetch("/api/push", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ subscription: sub, payload }),
      });
    } catch {}
  }, []);

  const postTap = useCallback((tap: { id: string; user: User; x: number; y: number }) => {
    fetch("/api/tap", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(tap),
    }).catch(() => {});
  }, []);

  const postHold = useCallback(
    (payload: {
      action: "start" | "move" | "end";
      id: string;
      user: User;
      x?: number;
      y?: number;
    }) => {
      fetch("/api/hold", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      }).catch(() => {});
    },
    []
  );

  const spawnHearts = (cx: number, cy: number, count: number) => {
    for (let i = 0; i < count; i++) {
      const angle = (i / count) * Math.PI * 2 + Math.random() * 0.4;
      const speed = 70 + Math.random() * 160;
      particlesRef.current.push({
        x: cx,
        y: cy,
        vx: Math.cos(angle) * speed,
        vy: Math.sin(angle) * speed - 60,
        life: 0,
        max: 1200 + Math.random() * 700,
        color: "#ff4fa8",
        size: 12 + Math.random() * 12,
        kind: "heart",
        gravity: 80,
        rot: Math.random() * Math.PI * 2,
        spin: (Math.random() - 0.5) * 2.5,
      });
    }
  };

  // Pointer + render
  useEffect(() => {
    if (!user) return;
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext("2d", { alpha: true });
    if (!ctx) return;

    const resize = () => {
      const dpr = window.devicePixelRatio || 1;
      canvas.width = window.innerWidth * dpr;
      canvas.height = window.innerHeight * dpr;
      canvas.style.width = window.innerWidth + "px";
      canvas.style.height = window.innerHeight + "px";
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    };
    resize();
    window.addEventListener("resize", resize);

    const vibrate = (pattern: number | number[]) => {
      if (typeof navigator !== "undefined" && "vibrate" in navigator) {
        try {
          navigator.vibrate(pattern);
        } catch {}
      }
    };

    const getCoords = (e: PointerEvent) => {
      const rect = canvas.getBoundingClientRect();
      return {
        x: (e.clientX - rect.left) / rect.width,
        y: (e.clientY - rect.top) / rect.height,
      };
    };

    const promoteToHold = (now: number) => {
      const s = pointerSessionRef.current;
      const me = userRef.current;
      if (!s || s.holdId || !me) return;
      const id = uid();
      s.holdId = id;
      s.lastSendAt = now;
      s.lastSentX = s.x;
      s.lastSentY = s.y;
      myHoldRef.current = {
        id,
        user: me,
        x: s.x,
        y: s.y,
        startedAt: s.startedAt,
        lastMoveAt: now,
        trail: [{ x: s.x, y: s.y, t: now }],
      };
      postHold({ action: "start", id, user: me, x: s.x, y: s.y });
      vibrate(12);
      sendPushMaybe();
    };

    const onDown = (e: PointerEvent) => {
      e.preventDefault();
      canvas.setPointerCapture(e.pointerId);
      const { x, y } = getCoords(e);
      const now = performance.now();
      pointerSessionRef.current = {
        pointerId: e.pointerId,
        startedAt: now,
        x,
        y,
        holdId: null,
        lastSendAt: 0,
        lastSentX: x,
        lastSentY: y,
      };
    };

    const onMove = (e: PointerEvent) => {
      const s = pointerSessionRef.current;
      if (!s || s.pointerId !== e.pointerId) return;
      const { x, y } = getCoords(e);
      s.x = x;
      s.y = y;
      const now = performance.now();

      if (!s.holdId) {
        // Maybe promote if past threshold
        if (now - s.startedAt >= HOLD_THRESHOLD_MS) promoteToHold(now);
        return;
      }

      // Active hold: update local and maybe broadcast
      const hold = myHoldRef.current;
      if (!hold || hold.id !== s.holdId) return;
      hold.x = x;
      hold.y = y;
      hold.lastMoveAt = now;
      hold.trail.push({ x, y, t: now });
      if (hold.trail.length > 8) hold.trail.shift();

      const dx = x - s.lastSentX;
      const dy = y - s.lastSentY;
      const delta = Math.hypot(dx, dy);
      if (now - s.lastSendAt >= MOVE_MIN_INTERVAL_MS && delta >= MOVE_MIN_DELTA) {
        s.lastSendAt = now;
        s.lastSentX = x;
        s.lastSentY = y;
        postHold({ action: "move", id: s.holdId, user: userRef.current!, x, y });
      }
    };

    const finishSession = (e: PointerEvent) => {
      const s = pointerSessionRef.current;
      if (!s || s.pointerId !== e.pointerId) return;
      pointerSessionRef.current = null;
      const me = userRef.current;
      if (!me) return;
      const now = performance.now();

      if (!s.holdId) {
        // It was a tap
        const tap: Tap = { id: uid(), user: me, x: s.x, y: s.y, bornAt: now };
        tapsRef.current.push(tap);
        postTap({ id: tap.id, user: me, x: s.x, y: s.y });
        sendPushMaybe();
        return;
      }

      // Finish the hold: move to decaying
      const hold = myHoldRef.current;
      if (hold && hold.id === s.holdId) {
        hold.ending = true;
        hold.endedAt = now;
        decayingHoldsRef.current.push(hold);
        myHoldRef.current = null;
      }
      postHold({ action: "end", id: s.holdId, user: me });
    };

    const onUp = (e: PointerEvent) => finishSession(e);
    const onCancel = (e: PointerEvent) => finishSession(e);

    canvas.addEventListener("pointerdown", onDown);
    canvas.addEventListener("pointermove", onMove);
    canvas.addEventListener("pointerup", onUp);
    canvas.addEventListener("pointercancel", onCancel);
    canvas.addEventListener("pointerleave", onCancel);

    // Held ripple radius scales with hold age, capped
    const heldRadius = (hold: Hold, now: number) => {
      const age = Math.max(0, now - hold.startedAt);
      const growth = 1 - Math.pow(2, -age / 600);
      const minSide = Math.min(window.innerWidth, window.innerHeight);
      return (0.08 + growth * 0.18) * minSide;
    };

    const endBond = (fx: number, fy: number) => {
      if (!bondedRef.current) return;
      const bx = bondedRef.current.centerX || fx;
      const by = bondedRef.current.centerY || fy;
      spawnHearts(bx, by, 24);
      vibrate([30, 50, 40, 60]);
      bondedRef.current = null;
    };

    const detectCrash = (now: number) => {
      const mine = myHoldRef.current;
      const theirs = theirHoldRef.current;
      if (!mine || !theirs) {
        endBond(0, 0);
        overlapStartedAtRef.current = null;
        overlapActiveRef.current = false;
        return;
      }
      const W = window.innerWidth;
      const H = window.innerHeight;
      const mx = mine.x * W;
      const my = mine.y * H;
      const tx = theirs.x * W;
      const ty = theirs.y * H;
      const d = Math.hypot(mx - tx, my - ty);
      const rSum = heldRadius(mine, now) + heldRadius(theirs, now);
      const cx = (mx + tx) / 2;
      const cy = (my + ty) / 2;

      if (d < rSum * 0.9) {
        if (overlapStartedAtRef.current == null) overlapStartedAtRef.current = now;
        const overlapDur = now - overlapStartedAtRef.current;

        if (overlapDur >= BOND_THRESHOLD_MS) {
          if (!bondedRef.current) {
            bondedRef.current = { since: now, centerX: cx, centerY: cy };
            spawnHearts(cx, cy, 26);
            vibrate([60, 80, 40, 80, 60]);
          } else {
            bondedRef.current.centerX = cx;
            bondedRef.current.centerY = cy;
          }
        } else {
          if (!overlapActiveRef.current && now - lastCrashAtRef.current > CRASH_INITIAL_COOLDOWN) {
            spawnHearts(cx, cy, 12);
            vibrate([20, 30, 40]);
            overlapActiveRef.current = true;
            lastCrashAtRef.current = now;
          } else if (overlapActiveRef.current && now - lastCrashAtRef.current > CRASH_TRICKLE_COOLDOWN) {
            spawnHearts(cx, cy, 1);
            lastCrashAtRef.current = now;
          }
        }
      } else {
        endBond(cx, cy);
        overlapStartedAtRef.current = null;
        overlapActiveRef.current = false;
      }
    };

    let rafId = 0;
    let lastT = performance.now();

    const draw = () => {
      const now = performance.now();
      const dt = Math.min(now - lastT, 50);
      lastT = now;

      const W = window.innerWidth;
      const H = window.innerHeight;
      const me = userRef.current;
      const bgPal = me ? PALETTE[me] : PALETTE.shehzaad;

      ctx.globalCompositeOperation = "source-over";
      const grad = ctx.createRadialGradient(W / 2, H / 2, 0, W / 2, H / 2, Math.max(W, H) / 1.2);
      grad.addColorStop(0, bgPal.bg2);
      grad.addColorStop(1, bgPal.bg1);
      ctx.fillStyle = grad;
      ctx.fillRect(0, 0, W, H);

      ctx.globalCompositeOperation = "lighter";

      // Auto-decay stale remote hold (connection drop safety)
      const staleTheirs = theirHoldRef.current;
      if (staleTheirs && now - staleTheirs.lastMoveAt > HOLD_STALE_MS) {
        staleTheirs.ending = true;
        staleTheirs.endedAt = now;
        decayingHoldsRef.current.push(staleTheirs);
        theirHoldRef.current = null;
      }

      // Decaying holds
      decayingHoldsRef.current = decayingHoldsRef.current.filter((h) => {
        const t = h.endedAt ? (now - h.endedAt) / DECAY_MS : 0;
        if (t >= 1) return false;
        const alpha = 1 - t;
        const cx = h.x * W;
        const cy = h.y * H;
        const radius = heldRadius(h, h.endedAt || now) * (1 + t * 0.6);
        drawHeldRipple(ctx, { x: cx, y: cy, r: radius, user: h.user, alpha: alpha * 0.8, now });
        return true;
      });

      const bonded = bondedRef.current;
      const theirs = theirHoldRef.current;
      const mine = myHoldRef.current;

      if (bonded && mine && theirs) {
        // Dim the individual held ripples; the bond is the main event.
        drawTrail(ctx, theirs, W, H, now);
        drawTrail(ctx, mine, W, H, now);
        drawHeldRipple(ctx, {
          x: theirs.x * W,
          y: theirs.y * H,
          r: heldRadius(theirs, now) * 0.85,
          user: theirs.user,
          alpha: 0.35,
          now,
        });
        drawHeldRipple(ctx, {
          x: mine.x * W,
          y: mine.y * H,
          r: heldRadius(mine, now) * 0.85,
          user: mine.user,
          alpha: 0.35,
          now,
        });

        const bondedR =
          Math.max(heldRadius(mine, now), heldRadius(theirs, now)) * 1.35 +
          Math.min((now - bonded.since) / 60, 40);
        drawBondedRipple(ctx, {
          x: bonded.centerX,
          y: bonded.centerY,
          r: bondedR,
          now,
          since: bonded.since,
        });
        drawBondLabel(ctx, bonded, now, bondedR);
      } else {
        if (theirs) {
          const cx = theirs.x * W;
          const cy = theirs.y * H;
          drawTrail(ctx, theirs, W, H, now);
          drawHeldRipple(ctx, { x: cx, y: cy, r: heldRadius(theirs, now), user: theirs.user, alpha: 0.95, now });
        }
        if (mine) {
          const cx = mine.x * W;
          const cy = mine.y * H;
          drawTrail(ctx, mine, W, H, now);
          drawHeldRipple(ctx, { x: cx, y: cy, r: heldRadius(mine, now), user: mine.user, alpha: 1, now });
        }
      }

      // Tap splashes
      tapsRef.current = tapsRef.current.filter((t) => {
        const age = now - t.bornAt;
        if (age > TAP_LIFE_MS) return false;
        const p = age / TAP_LIFE_MS;
        const r = (0.02 + p * 0.1) * Math.min(W, H);
        const alpha = (1 - p) * 0.95;
        drawSplash(ctx, { x: t.x * W, y: t.y * H, r, user: t.user, alpha });
        return true;
      });

      // Crash detection
      detectCrash(now);

      // Particles
      const pArr = particlesRef.current;
      for (let i = pArr.length - 1; i >= 0; i--) {
        const p = pArr[i];
        p.life += dt;
        if (p.life > p.max) {
          pArr.splice(i, 1);
          continue;
        }
        if (p.gravity) p.vy += (p.gravity * dt) / 1000;
        p.x += (p.vx * dt) / 1000;
        p.y += (p.vy * dt) / 1000;
        p.vx *= 0.99;
        if (!p.gravity) p.vy *= 0.99;
        if (p.spin) p.rot = (p.rot || 0) + (p.spin * dt) / 1000;
        const lp = 1 - p.life / p.max;
        ctx.globalAlpha = Math.max(0, lp);
        if (p.kind === "heart") {
          drawHeart(ctx, p.x, p.y, p.size * (0.6 + lp * 0.6), p.color, p.rot || 0);
        } else {
          ctx.fillStyle = p.color;
          ctx.beginPath();
          ctx.arc(p.x, p.y, p.size * (0.4 + lp * 0.8), 0, Math.PI * 2);
          ctx.fill();
        }
      }
      ctx.globalAlpha = 1;

      rafId = requestAnimationFrame(draw);
    };

    rafId = requestAnimationFrame(draw);

    return () => {
      cancelAnimationFrame(rafId);
      window.removeEventListener("resize", resize);
      canvas.removeEventListener("pointerdown", onDown);
      canvas.removeEventListener("pointermove", onMove);
      canvas.removeEventListener("pointerup", onUp);
      canvas.removeEventListener("pointercancel", onCancel);
      canvas.removeEventListener("pointerleave", onCancel);
    };
  }, [user, postTap, postHold, sendPushMaybe]);

  if (!user) {
    return (
      <main
        style={{
          display: "flex",
          flexDirection: "column",
          alignItems: "center",
          justifyContent: "center",
          gap: 32,
          padding: 24,
          background:
            "radial-gradient(circle at 30% 20%, #1a0030 0%, #000 60%), radial-gradient(circle at 70% 80%, #2a0020 0%, #000 60%)",
        }}
      >
        <h1
          style={{
            fontSize: "clamp(40px, 10vw, 80px)",
            fontWeight: 800,
            letterSpacing: "-0.04em",
            background: "linear-gradient(135deg, #00f0ff 0%, #ff4fa8 100%)",
            WebkitBackgroundClip: "text",
            WebkitTextFillColor: "transparent",
            textAlign: "center",
          }}
        >
          ripple
        </h1>
        <p style={{ opacity: 0.7, fontSize: 16, textAlign: "center" }}>who&apos;s tapping?</p>
        <div style={{ display: "flex", flexDirection: "column", gap: 16, width: "100%", maxWidth: 360 }}>
          <button onClick={() => choose("shehzaad")} style={btnStyle(PALETTE.shehzaad.buttonBg)}>
            Shehzaad
          </button>
          <button onClick={() => choose("maggie")} style={btnStyle(PALETTE.maggie.buttonBg)}>
            Maggie
          </button>
        </div>
      </main>
    );
  }

  const pal = PALETTE[user];

  return (
    <main style={{ position: "relative", touchAction: "none" }}>
      <canvas ref={canvasRef} style={{ display: "block", width: "100vw", height: "100dvh", touchAction: "none" }} />

      <div
        style={{
          position: "fixed",
          top: "max(16px, env(safe-area-inset-top))",
          left: 16,
          display: "flex",
          alignItems: "center",
          gap: 10,
          background: "rgba(0,0,0,0.4)",
          backdropFilter: "blur(8px)",
          padding: "8px 14px",
          borderRadius: 999,
          fontSize: 14,
          fontWeight: 600,
          pointerEvents: "none",
        }}
      >
        <span
          style={{
            width: 10,
            height: 10,
            borderRadius: 999,
            background: connected ? "#00ff88" : "#ff4040",
            boxShadow: connected ? "0 0 10px #00ff88" : "0 0 8px #ff4040",
          }}
        />
        <span style={{ opacity: 0.9 }}>{pal.name}</span>
      </div>

      <div
        style={{
          position: "fixed",
          top: "max(16px, env(safe-area-inset-top))",
          right: 16,
          display: "flex",
          gap: 8,
          alignItems: "center",
        }}
      >
        {pushStatus !== "granted" && pushStatus !== "unsupported" && (
          <button
            onClick={enablePush}
            style={{
              background: pal.buttonBg,
              color: "#fff",
              border: "none",
              padding: "8px 14px",
              borderRadius: 999,
              fontSize: 13,
              fontWeight: 700,
              cursor: "pointer",
              boxShadow: "0 4px 18px rgba(0,0,0,0.4)",
            }}
          >
            🔔 pings
          </button>
        )}
        {pushStatus === "granted" && (
          <div
            style={{
              background: "rgba(0,0,0,0.4)",
              backdropFilter: "blur(8px)",
              color: "#fff",
              padding: "8px 14px",
              borderRadius: 999,
              fontSize: 13,
              fontWeight: 600,
              opacity: 0.85,
            }}
          >
            🔔 on
          </div>
        )}
        <button
          onClick={resetUser}
          style={{
            background: "rgba(0,0,0,0.4)",
            backdropFilter: "blur(8px)",
            color: "#fff",
            border: "none",
            padding: "8px 14px",
            borderRadius: 999,
            fontSize: 13,
            fontWeight: 500,
            opacity: 0.7,
            cursor: "pointer",
          }}
        >
          switch
        </button>
      </div>

      <div
        style={{
          position: "fixed",
          bottom: "max(20px, calc(env(safe-area-inset-bottom) + 20px))",
          left: 0,
          right: 0,
          textAlign: "center",
          fontSize: 12,
          opacity: 0.4,
          pointerEvents: "none",
        }}
      >
        tap · hold to drag · crash into theirs
      </div>

      {!isStandalone && pushStatus !== "granted" && !showInstallHint && (
        <button
          onClick={() => setShowInstallHint(true)}
          style={{
            position: "fixed",
            bottom: "max(50px, calc(env(safe-area-inset-bottom) + 50px))",
            left: "50%",
            transform: "translateX(-50%)",
            background: "rgba(255,255,255,0.1)",
            color: "#fff",
            border: "1px solid rgba(255,255,255,0.2)",
            padding: "6px 12px",
            borderRadius: 999,
            fontSize: 11,
            fontWeight: 500,
            opacity: 0.65,
            cursor: "pointer",
            pointerEvents: "auto",
          }}
        >
          📱 how to enable pings
        </button>
      )}
      {showInstallHint && (
        <div
          onClick={() => setShowInstallHint(false)}
          style={{
            position: "fixed",
            inset: 0,
            background: "rgba(0,0,0,0.75)",
            backdropFilter: "blur(10px)",
            display: "flex",
            flexDirection: "column",
            alignItems: "center",
            justifyContent: "center",
            padding: 24,
            zIndex: 10,
          }}
        >
          <div
            style={{
              background: "#111",
              border: "1px solid rgba(255,255,255,0.1)",
              padding: 24,
              borderRadius: 20,
              maxWidth: 340,
              textAlign: "center",
            }}
          >
            <h3
              style={{
                fontSize: 20,
                fontWeight: 800,
                marginBottom: 12,
                background: pal.buttonBg,
                WebkitBackgroundClip: "text",
                WebkitTextFillColor: "transparent",
              }}
            >
              add to home screen
            </h3>
            <p style={{ fontSize: 14, opacity: 0.8, lineHeight: 1.5, marginBottom: 16 }}>
              tap <strong>Share</strong> → <strong>Add to Home Screen</strong>. open the ripple app from there → tap 🔔
              pings → allow notifications. now you&apos;ll get pinged when the other is rippling.
            </p>
            <p style={{ fontSize: 12, opacity: 0.5 }}>tap anywhere to close</p>
          </div>
        </div>
      )}
    </main>
  );
}

function btnStyle(bg: string): React.CSSProperties {
  return {
    padding: "18px 24px",
    borderRadius: 20,
    border: "none",
    background: bg,
    color: "#fff",
    fontSize: 22,
    fontWeight: 700,
    letterSpacing: "-0.01em",
    cursor: "pointer",
    boxShadow: "0 10px 40px rgba(0,0,0,0.5), inset 0 1px 0 rgba(255,255,255,0.2)",
  };
}

function drawHeldRipple(
  ctx: CanvasRenderingContext2D,
  opts: { x: number; y: number; r: number; user: User; alpha: number; now: number }
) {
  const pal = PALETTE[opts.user];
  const [pr, pg, pb] = pal.primary;
  const [sr, sg, sb] = pal.secondary;
  const a = opts.alpha;

  // Core gradient disc
  const core = ctx.createRadialGradient(opts.x, opts.y, 0, opts.x, opts.y, opts.r);
  core.addColorStop(0, `rgba(${sr},${sg},${sb},${a * 0.7})`);
  core.addColorStop(0.45, `rgba(${pr},${pg},${pb},${a * 0.4})`);
  core.addColorStop(1, `rgba(${pr},${pg},${pb},0)`);
  ctx.fillStyle = core;
  ctx.beginPath();
  ctx.arc(opts.x, opts.y, opts.r, 0, Math.PI * 2);
  ctx.fill();

  // Continuously emitted sonar rings (3 at different phases)
  const phase = opts.now * 0.001;
  for (let i = 0; i < 3; i++) {
    const t = (phase + i / 3) % 1;
    const rr = opts.r * (0.6 + t * 1.2);
    const ringA = a * (1 - t) * 0.8;
    ctx.strokeStyle = `rgba(${pr},${pg},${pb},${ringA})`;
    ctx.lineWidth = 2 + (1 - t) * 3;
    ctx.beginPath();
    ctx.arc(opts.x, opts.y, rr, 0, Math.PI * 2);
    ctx.stroke();
  }

  // Per-user flourish (lightning / sparkles)
  if (pal.vibe === "epic") {
    const arcs = 3;
    for (let i = 0; i < arcs; i++) {
      const ang = (i / arcs) * Math.PI * 2 + phase * 4;
      ctx.strokeStyle = `rgba(255,255,255,${a * 0.45})`;
      ctx.lineWidth = 1.3;
      ctx.beginPath();
      ctx.moveTo(opts.x + Math.cos(ang) * opts.r * 0.15, opts.y + Math.sin(ang) * opts.r * 0.15);
      const segs = 5;
      for (let s = 1; s <= segs; s++) {
        const tr = (s / segs) * opts.r * 0.95;
        const j = ((Math.random() - 0.5) * opts.r) / 8;
        ctx.lineTo(opts.x + Math.cos(ang) * tr + j, opts.y + Math.sin(ang) * tr + j);
      }
      ctx.stroke();
    }
  } else {
    const sparks = 5;
    for (let i = 0; i < sparks; i++) {
      const ang = (i / sparks) * Math.PI * 2 + phase * 2;
      const rad = opts.r * (0.75 + Math.sin(phase * 5 + i) * 0.15);
      const px = opts.x + Math.cos(ang) * rad;
      const py = opts.y + Math.sin(ang) * rad;
      drawStar(ctx, px, py, 3 + opts.r * 0.04, `rgba(255,240,245,${a * 0.9})`);
    }
  }
}

function drawTrail(
  ctx: CanvasRenderingContext2D,
  hold: Hold,
  W: number,
  H: number,
  now: number
) {
  if (hold.trail.length < 2) return;
  const pal = PALETTE[hold.user];
  const [pr, pg, pb] = pal.primary;
  for (let i = 0; i < hold.trail.length - 1; i++) {
    const p = hold.trail[i];
    const age = (now - p.t) / 500;
    if (age >= 1) continue;
    const alpha = (1 - age) * 0.4;
    const radius = (0.04 + (1 - age) * 0.02) * Math.min(W, H);
    ctx.fillStyle = `rgba(${pr},${pg},${pb},${alpha})`;
    ctx.beginPath();
    ctx.arc(p.x * W, p.y * H, radius, 0, Math.PI * 2);
    ctx.fill();
  }
}

function drawSplash(
  ctx: CanvasRenderingContext2D,
  opts: { x: number; y: number; r: number; user: User; alpha: number }
) {
  const pal = PALETTE[opts.user];
  const [pr, pg, pb] = pal.primary;
  ctx.strokeStyle = `rgba(${pr},${pg},${pb},${opts.alpha})`;
  ctx.lineWidth = 2.5;
  ctx.beginPath();
  ctx.arc(opts.x, opts.y, opts.r, 0, Math.PI * 2);
  ctx.stroke();

  const core = ctx.createRadialGradient(opts.x, opts.y, 0, opts.x, opts.y, opts.r * 0.8);
  core.addColorStop(0, `rgba(${pr},${pg},${pb},${opts.alpha * 0.4})`);
  core.addColorStop(1, `rgba(${pr},${pg},${pb},0)`);
  ctx.fillStyle = core;
  ctx.beginPath();
  ctx.arc(opts.x, opts.y, opts.r * 0.8, 0, Math.PI * 2);
  ctx.fill();
}

function drawStar(ctx: CanvasRenderingContext2D, x: number, y: number, size: number, color: string) {
  ctx.fillStyle = color;
  ctx.save();
  ctx.translate(x, y);
  ctx.beginPath();
  for (let i = 0; i < 8; i++) {
    const ang = (i / 8) * Math.PI * 2;
    const r = i % 2 === 0 ? size : size * 0.4;
    const px = Math.cos(ang) * r;
    const py = Math.sin(ang) * r;
    if (i === 0) ctx.moveTo(px, py);
    else ctx.lineTo(px, py);
  }
  ctx.closePath();
  ctx.fill();
  ctx.restore();
}

function drawBondedRipple(
  ctx: CanvasRenderingContext2D,
  opts: { x: number; y: number; r: number; now: number; since: number }
) {
  const age = opts.now - opts.since;
  const pulse = 1 + Math.sin(age * 0.006) * 0.12;
  const R = opts.r * pulse;

  // Outer warm halo
  const halo = ctx.createRadialGradient(opts.x, opts.y, 0, opts.x, opts.y, R * 2);
  halo.addColorStop(0, "rgba(255, 160, 210, 0.35)");
  halo.addColorStop(0.45, "rgba(160, 120, 255, 0.18)");
  halo.addColorStop(1, "rgba(0, 240, 255, 0)");
  ctx.fillStyle = halo;
  ctx.beginPath();
  ctx.arc(opts.x, opts.y, R * 2, 0, Math.PI * 2);
  ctx.fill();

  // Rotating conic body blending both palettes
  const supportsConic = typeof (ctx as CanvasRenderingContext2D & {
    createConicGradient?: (angle: number, x: number, y: number) => CanvasGradient;
  }).createConicGradient === "function";
  if (supportsConic) {
    const conic = (ctx as CanvasRenderingContext2D & {
      createConicGradient: (angle: number, x: number, y: number) => CanvasGradient;
    }).createConicGradient(age * 0.002, opts.x, opts.y);
    conic.addColorStop(0, "#00f0ff");
    conic.addColorStop(0.2, "#a020ff");
    conic.addColorStop(0.4, "#ff4fa8");
    conic.addColorStop(0.6, "#ffb6c1");
    conic.addColorStop(0.8, "#a020ff");
    conic.addColorStop(1, "#00f0ff");
    ctx.save();
    ctx.globalAlpha = 0.55;
    ctx.fillStyle = conic;
    ctx.beginPath();
    ctx.arc(opts.x, opts.y, R, 0, Math.PI * 2);
    ctx.fill();
    ctx.restore();
  } else {
    const core = ctx.createRadialGradient(opts.x, opts.y, 0, opts.x, opts.y, R);
    core.addColorStop(0, "rgba(255,120,200,0.6)");
    core.addColorStop(0.6, "rgba(120,140,255,0.35)");
    core.addColorStop(1, "rgba(0,240,255,0)");
    ctx.fillStyle = core;
    ctx.beginPath();
    ctx.arc(opts.x, opts.y, R, 0, Math.PI * 2);
    ctx.fill();
  }

  // Bright core pulse
  const corePulse = 0.5 + Math.sin(age * 0.008) * 0.2;
  const coreR = R * 0.5 * corePulse;
  const coreGrad = ctx.createRadialGradient(opts.x, opts.y, 0, opts.x, opts.y, coreR);
  coreGrad.addColorStop(0, "rgba(255, 255, 255, 0.95)");
  coreGrad.addColorStop(0.5, "rgba(255, 220, 240, 0.5)");
  coreGrad.addColorStop(1, "rgba(255, 220, 240, 0)");
  ctx.fillStyle = coreGrad;
  ctx.beginPath();
  ctx.arc(opts.x, opts.y, coreR, 0, Math.PI * 2);
  ctx.fill();

  // Outgoing heartbeat rings
  const phase = (age * 0.0009) % 1;
  for (let i = 0; i < 3; i++) {
    const t = (phase + i / 3) % 1;
    const rr = R * (0.95 + t * 1.3);
    const a = (1 - t) * 0.55;
    ctx.strokeStyle = `rgba(255, 180, 220, ${a})`;
    ctx.lineWidth = 2 + (1 - t) * 3;
    ctx.beginPath();
    ctx.arc(opts.x, opts.y, rr, 0, Math.PI * 2);
    ctx.stroke();
  }

  // Counter-rotating orbital stars
  const orbitR = R * 1.15;
  for (let i = 0; i < 6; i++) {
    const a = -age * 0.0011 + (i / 6) * Math.PI * 2;
    const px = opts.x + Math.cos(a) * orbitR;
    const py = opts.y + Math.sin(a) * orbitR;
    drawStar(ctx, px, py, 3 + Math.sin(age * 0.004 + i) * 1.5, "rgba(255, 240, 245, 0.85)");
  }
}

function drawBondLabel(
  ctx: CanvasRenderingContext2D,
  bond: { since: number; centerX: number; centerY: number },
  now: number,
  bondR: number
) {
  const bondAge = now - bond.since;
  const idx = Math.floor(bondAge / BOND_LABEL_CYCLE_MS) % BOND_LABELS.length;
  const label = BOND_LABELS[idx];
  const phase = (bondAge % BOND_LABEL_CYCLE_MS) / BOND_LABEL_CYCLE_MS;
  let alpha: number;
  if (phase < 0.2) alpha = phase / 0.2;
  else if (phase > 0.8) alpha = (1 - phase) / 0.2;
  else alpha = 1;
  alpha *= 0.5;
  ctx.save();
  ctx.globalCompositeOperation = "source-over";
  ctx.font = "600 13px -apple-system, BlinkMacSystemFont, sans-serif";
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  ctx.shadowColor = "rgba(0,0,0,0.6)";
  ctx.shadowBlur = 6;
  ctx.fillStyle = `rgba(255, 230, 240, ${alpha})`;
  ctx.fillText(label, bond.centerX, bond.centerY + bondR + 28);
  ctx.restore();
}

function drawHeart(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  size: number,
  color: string,
  rot: number
) {
  ctx.save();
  ctx.translate(x, y);
  ctx.rotate(rot);
  ctx.scale(size / 20, size / 20);
  ctx.fillStyle = color;
  ctx.shadowColor = color;
  ctx.shadowBlur = 12;
  ctx.beginPath();
  ctx.moveTo(0, 6);
  ctx.bezierCurveTo(-10, -4, -14, 2, 0, 14);
  ctx.bezierCurveTo(14, 2, 10, -4, 0, 6);
  ctx.closePath();
  ctx.fill();
  ctx.restore();
}
