"use client";

import { useEffect, useRef, useState, useCallback } from "react";
import Pusher, { Channel } from "pusher-js";

type User = "shehzaad" | "maggie";

type Ripple = {
  id: string;
  user: User;
  x: number;
  y: number;
  intensity: number;
  createdAt: number;
  duration: number;
  genZ?: string;
  broken?: { by: User; at: number };
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
  kind: "spark" | "star" | "shard" | "heart" | "emoji";
  char?: string;
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
    genZ: [
      "locked in",
      "mogged",
      "no diff",
      "+1000 aura",
      "sigma",
      "mewing",
      "pressmaxxing",
      "ripplemaxxing",
      "hunter eyes",
      "goated",
      "gigachad",
      "PSL 8",
    ],
    emoji: ["⚡", "🔥", "💥", "⭐", "💀", "🗿"],
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
    genZ: [
      "clav maxxing",
      "mogging",
      "hollow cheeks",
      "+500 aura",
      "hunter eyes",
      "mewing",
      "stacey",
      "mother",
      "PSL 9",
      "it's giving",
      "serving",
      "ripplemaxxing",
    ],
    emoji: ["💖", "✨", "🌸", "💕", "🦋", "🩷"],
    pushEmoji: "💕",
  },
} as const;

const COMBO_TIERS: Array<{ at: number; label: string; emoji: string; color: string }> = [
  { at: 3, label: "locked in", emoji: "🔒", color: "#00f0ff" },
  { at: 6, label: "mogging", emoji: "🥶", color: "#a020ff" },
  { at: 10, label: "ripplemaxxing", emoji: "🌊", color: "#00f0ff" },
  { at: 16, label: "+500 aura", emoji: "✴️", color: "#c084fc" },
  { at: 24, label: "clavicle maxxing", emoji: "🦴", color: "#fde047" },
  { at: 35, label: "pressmaxxing", emoji: "👆", color: "#ff4fa8" },
  { at: 50, label: "PSL 10", emoji: "📊", color: "#00ff88" },
];

const uid = () => Math.random().toString(36).slice(2, 10) + Date.now().toString(36);
const CHANNEL = "ripple-room";

function getComboTier(count: number) {
  let tier = null;
  for (const t of COMBO_TIERS) if (count >= t.at) tier = t;
  return tier;
}

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
  const [comboDisplay, setComboDisplay] = useState<{ count: number; tier: typeof COMBO_TIERS[number] | null } | null>(null);
  const [fusionCount, setFusionCount] = useState(0);

  const canvasRef = useRef<HTMLCanvasElement>(null);
  const ripplesRef = useRef<Map<string, Ripple>>(new Map());
  const particlesRef = useRef<Particle[]>([]);
  const holdRef = useRef<{
    x: number;
    y: number;
    startedAt: number;
    pointerId: number;
    breakTargetId?: string;
  } | null>(null);
  const userRef = useRef<User | null>(null);
  const channelRef = useRef<Channel | null>(null);
  const ownSubRef = useRef<PushSub | null>(null);
  const otherSubRef = useRef<PushSub | null>(null);
  const lastSubBroadcastRef = useRef<number>(0);
  const lastPushSentRef = useRef<number>(0);
  const comboRef = useRef<{ count: number; lastAt: number }>({ count: 0, lastAt: 0 });

  useEffect(() => {
    const saved = (typeof window !== "undefined" && localStorage.getItem("ripple-user")) as User | null;
    if (saved === "shehzaad" || saved === "maggie") setUser(saved);
    // restore other sub
    try {
      const s = localStorage.getItem("ripple-other-sub");
      if (s) otherSubRef.current = JSON.parse(s);
    } catch {}
    // check standalone
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

  // Register service worker
  useEffect(() => {
    if (!user) return;
    if (typeof window === "undefined" || !("serviceWorker" in navigator)) {
      setPushStatus("unsupported");
      return;
    }
    navigator.serviceWorker
      .register("/sw.js")
      .then(async () => {
        // Check existing subscription
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

    // Receive messages from the SW (e.g. push-while-visible)
    const onMsg = (e: MessageEvent) => {
      if (e.data?.type === "push-while-visible") {
        // could add a subtle animation; for now, no-op
      }
    };
    navigator.serviceWorker.addEventListener("message", onMsg);
    return () => navigator.serviceWorker.removeEventListener("message", onMsg);
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
      const subJson = sub.toJSON() as PushSub;
      ownSubRef.current = subJson;
      setPushStatus("granted");
      broadcastOwnSub();
    } catch {
      setPushStatus("idle");
    }
  };

  const broadcastOwnSub = useCallback(() => {
    const me = userRef.current;
    const sub = ownSubRef.current;
    const ch = channelRef.current;
    if (!me || !sub || !ch) return;
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

    channel.bind("ripple", (data: Ripple) => {
      if (ripplesRef.current.has(data.id)) return;
      ripplesRef.current.set(data.id, data);
      // heart fusion: if we have a local ripple overlapping, burst hearts
      if (data.user !== userRef.current) checkFusion(data);
    });

    channel.bind("break", (data: { id: string; by: User; at: number }) => {
      const r = ripplesRef.current.get(data.id);
      if (!r || r.broken) return;
      r.broken = { by: data.by, at: data.at };
      spawnShatter(r, data.by);
    });

    channel.bind("push-sub", (data: { user: User; sub: PushSub }) => {
      if (data.user === userRef.current) return;
      otherSubRef.current = data.sub;
      try { localStorage.setItem("ripple-other-sub", JSON.stringify(data.sub)); } catch {}
      // reciprocate once so the other side gets ours if they haven't yet
      if (ownSubRef.current) broadcastOwnSub();
    });

    return () => {
      channel.unbind_all();
      pusher.unsubscribe(CHANNEL);
      pusher.disconnect();
      channelRef.current = null;
    };
  }, [user, broadcastOwnSub]);

  const checkFusion = (incoming: Ripple) => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const me = userRef.current;
    if (!me) return;
    const rect = canvas.getBoundingClientRect();
    const now = performance.now();
    const minSide = Math.min(window.innerWidth, window.innerHeight);
    const incomingAt = Date.now() > 1e11 ? incoming.createdAt - (Date.now() - performance.now()) : incoming.createdAt;
    const ix = incoming.x * rect.width;
    const iy = incoming.y * rect.height;
    ripplesRef.current.forEach((r) => {
      if (r.id === incoming.id) return;
      if (r.user === incoming.user) return;
      if (r.broken) return;
      const age = now - r.createdAt;
      if (age > r.duration) return;
      const cx = r.x * rect.width;
      const cy = r.y * rect.height;
      const d = Math.hypot(ix - cx, iy - cy);
      const maxR = (0.2 + Math.max(r.intensity, incoming.intensity) * 0.5) * minSide;
      if (d < maxR) {
        spawnHearts((ix + cx) / 2, (iy + cy) / 2, 22);
        setFusionCount((c) => c + 1);
      }
    });
    void incomingAt;
  };

  const broadcastRipple = useCallback(async (ripple: Ripple) => {
    try {
      await fetch("/api/ripple", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(ripple),
      });
    } catch {}
  }, []);

  const broadcastBreak = useCallback(async (payload: { id: string; by: User; at: number }) => {
    try {
      await fetch("/api/break", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
    } catch {}
  }, []);

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

  const spawnShatter = (r: Ripple, by: User) => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const rect = canvas.getBoundingClientRect();
    const cx = r.x * rect.width;
    const cy = r.y * rect.height;
    const col = PALETTE[r.user];
    const count = 28 + Math.floor(r.intensity * 30);
    for (let i = 0; i < count; i++) {
      const angle = (i / count) * Math.PI * 2 + Math.random() * 0.3;
      const speed = 120 + Math.random() * 260 * (0.5 + r.intensity);
      particlesRef.current.push({
        x: cx,
        y: cy,
        vx: Math.cos(angle) * speed,
        vy: Math.sin(angle) * speed,
        life: 0,
        max: 700 + Math.random() * 500,
        color: `rgb(${col.primary.join(",")})`,
        size: 2 + Math.random() * 3,
        kind: "shard",
      });
    }
    const br = PALETTE[by];
    for (let i = 0; i < 12; i++) {
      const angle = Math.random() * Math.PI * 2;
      const speed = 80 + Math.random() * 160;
      particlesRef.current.push({
        x: cx,
        y: cy,
        vx: Math.cos(angle) * speed,
        vy: Math.sin(angle) * speed,
        life: 0,
        max: 600 + Math.random() * 400,
        color: `rgb(${br.accent.join(",")})`,
        size: 3 + Math.random() * 4,
        kind: "star",
      });
    }
  };

  const spawnHearts = (cx: number, cy: number, count: number) => {
    for (let i = 0; i < count; i++) {
      const angle = (i / count) * Math.PI * 2 + Math.random() * 0.4;
      const speed = 60 + Math.random() * 180;
      particlesRef.current.push({
        x: cx,
        y: cy,
        vx: Math.cos(angle) * speed,
        vy: Math.sin(angle) * speed - 80,
        life: 0,
        max: 1400 + Math.random() * 800,
        color: "#ff4fa8",
        size: 14 + Math.random() * 14,
        kind: "heart",
        gravity: 60,
        rot: Math.random() * Math.PI * 2,
        spin: (Math.random() - 0.5) * 2,
      });
    }
  };

  const spawnEmojiBurst = (cx: number, cy: number, user: User, intensity: number) => {
    const pool = PALETTE[user].emoji;
    const count = 6 + Math.floor(intensity * 10);
    for (let i = 0; i < count; i++) {
      const angle = -Math.PI / 2 + (Math.random() - 0.5) * 1.6;
      const speed = 140 + Math.random() * 220;
      particlesRef.current.push({
        x: cx + (Math.random() - 0.5) * 20,
        y: cy,
        vx: Math.cos(angle) * speed,
        vy: Math.sin(angle) * speed,
        life: 0,
        max: 1500 + Math.random() * 800,
        color: "#ffffff",
        size: 22 + Math.random() * 16,
        kind: "emoji",
        char: pool[Math.floor(Math.random() * pool.length)],
        gravity: 400,
        rot: (Math.random() - 0.5) * 0.6,
        spin: (Math.random() - 0.5) * 4,
      });
    }
  };

  const bumpCombo = () => {
    const now = performance.now();
    if (now - comboRef.current.lastAt > 2000) comboRef.current.count = 0;
    comboRef.current.count += 1;
    comboRef.current.lastAt = now;
    const tier = getComboTier(comboRef.current.count);
    setComboDisplay({ count: comboRef.current.count, tier });
  };

  // decay combo display
  useEffect(() => {
    const id = setInterval(() => {
      if (comboRef.current.count > 0 && performance.now() - comboRef.current.lastAt > 2200) {
        comboRef.current.count = 0;
        setComboDisplay(null);
      }
    }, 300);
    return () => clearInterval(id);
  }, []);

  // Pointer + animation
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
        try { navigator.vibrate(pattern); } catch {}
      }
    };

    const getCoords = (e: PointerEvent) => {
      const rect = canvas.getBoundingClientRect();
      return {
        x: (e.clientX - rect.left) / rect.width,
        y: (e.clientY - rect.top) / rect.height,
        px: e.clientX - rect.left,
        py: e.clientY - rect.top,
      };
    };

    const currentRadius = (r: Ripple, now: number) => {
      const age = now - r.createdAt;
      const p = Math.min(age / r.duration, 1);
      const maxR = (0.15 + r.intensity * 0.55) * Math.min(window.innerWidth, window.innerHeight);
      return maxR * (1 - Math.pow(1 - p, 3));
    };

    const findHit = (px: number, py: number): Ripple | null => {
      const now = performance.now();
      const me = userRef.current;
      let bestR: Ripple | null = null;
      let bestD = Infinity;
      const rect = canvas.getBoundingClientRect();
      ripplesRef.current.forEach((r) => {
        if (r.user === me) return;
        if (r.broken) return;
        const age = now - r.createdAt;
        if (age > r.duration) return;
        const cx = r.x * rect.width;
        const cy = r.y * rect.height;
        const rad = currentRadius(r, now);
        const d = Math.hypot(px - cx, py - cy);
        if (d <= rad * 1.1 && d < bestD) {
          bestD = d;
          bestR = r;
        }
      });
      return bestR;
    };

    const onDown = (e: PointerEvent) => {
      e.preventDefault();
      canvas.setPointerCapture(e.pointerId);
      const { x, y, px, py } = getCoords(e);
      const hit = findHit(px, py);
      holdRef.current = {
        x,
        y,
        startedAt: performance.now(),
        pointerId: e.pointerId,
        breakTargetId: hit?.id,
      };
      if (hit) vibrate([15, 30, 25]);
      else vibrate(8);
    };

    const onUp = (e: PointerEvent) => {
      const hold = holdRef.current;
      if (!hold || hold.pointerId !== e.pointerId) return;
      holdRef.current = null;
      const me = userRef.current;
      if (!me) return;
      const heldMs = performance.now() - hold.startedAt;
      const intensity = Math.min(heldMs / 1800, 1);
      const now = Date.now();
      const duration = 2400 + intensity * 3600;

      if (hold.breakTargetId) {
        const target = ripplesRef.current.get(hold.breakTargetId);
        if (target && !target.broken) {
          target.broken = { by: me, at: now };
          spawnShatter(target, me);
          broadcastBreak({ id: target.id, by: me, at: now });
          vibrate([20, 40, 60]);
        }
      }

      const pal = PALETTE[me];
      const genZ = Math.random() < 0.45 ? pal.genZ[Math.floor(Math.random() * pal.genZ.length)] : undefined;

      const rippleLocal: Ripple = {
        id: uid(),
        user: me,
        x: hold.x,
        y: hold.y,
        intensity,
        createdAt: performance.now(),
        duration,
        genZ,
      };
      const sendable: Ripple = { ...rippleLocal, createdAt: now };
      ripplesRef.current.set(rippleLocal.id, rippleLocal);
      broadcastRipple(sendable);

      bumpCombo();

      // check heart fusion against existing remote ripples
      checkFusion(rippleLocal);

      // emoji confetti on long hold
      if (intensity > 0.4) {
        const rect = canvas.getBoundingClientRect();
        spawnEmojiBurst(hold.x * rect.width, hold.y * rect.height, me, intensity);
        vibrate([25, 20, 40]);
      }

      // push notify the other side, throttled
      sendPushMaybe();
    };

    const onCancel = (e: PointerEvent) => {
      if (holdRef.current?.pointerId === e.pointerId) holdRef.current = null;
    };

    canvas.addEventListener("pointerdown", onDown);
    canvas.addEventListener("pointerup", onUp);
    canvas.addEventListener("pointercancel", onCancel);
    canvas.addEventListener("pointerleave", onCancel);

    const normalizeLoop = setInterval(() => {
      const perfOffset = Date.now() - performance.now();
      ripplesRef.current.forEach((r) => {
        if (r.createdAt > 1e11) r.createdAt = r.createdAt - perfOffset;
      });
    }, 100);

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

      const hold = holdRef.current;
      if (hold && me) {
        const heldMs = now - hold.startedAt;
        const intensity = Math.min(heldMs / 1800, 1);
        const px = hold.x * W;
        const py = hold.y * H;
        const pr = 10 + intensity * Math.min(W, H) * 0.35;
        const pulse = 1 + Math.sin(now * 0.012) * 0.08;
        drawRipple(ctx, {
          x: px,
          y: py,
          r: pr * pulse,
          intensity,
          progress: 0.2 + intensity * 0.5,
          user: me,
          ghost: true,
          breakTarget: !!hold.breakTargetId,
        });
      }

      const toDelete: string[] = [];
      ripplesRef.current.forEach((r) => {
        const age = now - r.createdAt;
        if (age > r.duration + 200) { toDelete.push(r.id); return; }
        const p = Math.min(age / r.duration, 1);
        const rad = currentRadius(r, now);
        const cx = r.x * W;
        const cy = r.y * H;
        const brokenFade = r.broken ? Math.max(0, 1 - (now - (r.broken.at - (Date.now() - performance.now()))) / 500) : 1;
        drawRipple(ctx, {
          x: cx,
          y: cy,
          r: rad,
          intensity: r.intensity,
          progress: p,
          user: r.user,
          fade: brokenFade,
          label: r.genZ,
        });
      });
      toDelete.forEach((id) => ripplesRef.current.delete(id));

      const pArr = particlesRef.current;
      for (let i = pArr.length - 1; i >= 0; i--) {
        const p = pArr[i];
        p.life += dt;
        if (p.life > p.max) { pArr.splice(i, 1); continue; }
        if (p.gravity) p.vy += (p.gravity * dt) / 1000;
        p.x += (p.vx * dt) / 1000;
        p.y += (p.vy * dt) / 1000;
        p.vx *= 0.992;
        if (!p.gravity) p.vy *= 0.992;
        if (p.spin) p.rot = (p.rot || 0) + (p.spin * dt) / 1000;
        const lp = 1 - p.life / p.max;
        ctx.globalAlpha = Math.max(0, lp);
        if (p.kind === "star") {
          drawStar(ctx, p.x, p.y, p.size * (0.6 + lp * 0.6), p.color);
        } else if (p.kind === "heart") {
          drawHeart(ctx, p.x, p.y, p.size * (0.6 + lp * 0.6), p.color, p.rot || 0);
        } else if (p.kind === "emoji") {
          ctx.save();
          ctx.translate(p.x, p.y);
          ctx.rotate(p.rot || 0);
          ctx.font = `${p.size}px -apple-system, sans-serif`;
          ctx.textAlign = "center";
          ctx.textBaseline = "middle";
          ctx.fillText(p.char || "✨", 0, 0);
          ctx.restore();
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
      clearInterval(normalizeLoop);
      window.removeEventListener("resize", resize);
      canvas.removeEventListener("pointerdown", onDown);
      canvas.removeEventListener("pointerup", onUp);
      canvas.removeEventListener("pointercancel", onCancel);
      canvas.removeEventListener("pointerleave", onCancel);
    };
  }, [user, broadcastRipple, broadcastBreak, sendPushMaybe]);

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

      {/* top-left: identity + connection */}
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

      {/* top-right: push + switch */}
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

      {/* combo badge */}
      {comboDisplay && comboDisplay.count >= 3 && comboDisplay.tier && (
        <div
          key={comboDisplay.tier.label + comboDisplay.count}
          style={{
            position: "fixed",
            bottom: "max(72px, calc(env(safe-area-inset-bottom) + 72px))",
            right: 20,
            background: "rgba(0,0,0,0.55)",
            backdropFilter: "blur(10px)",
            border: `1.5px solid ${comboDisplay.tier.color}`,
            padding: "10px 16px",
            borderRadius: 18,
            fontSize: 15,
            fontWeight: 800,
            letterSpacing: "-0.01em",
            color: "#fff",
            display: "flex",
            alignItems: "center",
            gap: 10,
            pointerEvents: "none",
            animation: "pop 0.4s ease-out",
            boxShadow: `0 0 40px ${comboDisplay.tier.color}80`,
          }}
        >
          <span style={{ fontSize: 22 }}>{comboDisplay.tier.emoji}</span>
          <span style={{ color: comboDisplay.tier.color }}>{comboDisplay.tier.label}</span>
          <span style={{ opacity: 0.7 }}>×{comboDisplay.count}</span>
        </div>
      )}

      {/* fusion counter */}
      {fusionCount > 0 && (
        <div
          style={{
            position: "fixed",
            bottom: "max(72px, calc(env(safe-area-inset-bottom) + 72px))",
            left: 20,
            background: "rgba(0,0,0,0.55)",
            backdropFilter: "blur(10px)",
            padding: "8px 14px",
            borderRadius: 18,
            fontSize: 13,
            fontWeight: 700,
            color: "#ff4fa8",
            pointerEvents: "none",
            boxShadow: "0 0 30px rgba(255,79,168,0.4)",
          }}
        >
          💕 fused {fusionCount}
        </div>
      )}

      {/* bottom hint */}
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
        tap · hold · break theirs · fuse for hearts · keep tapping for aura
      </div>

      {/* install hint for iOS non-standalone */}
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
            <h3 style={{ fontSize: 20, fontWeight: 800, marginBottom: 12, background: pal.buttonBg, WebkitBackgroundClip: "text", WebkitTextFillColor: "transparent" }}>
              add to home screen
            </h3>
            <p style={{ fontSize: 14, opacity: 0.8, lineHeight: 1.5, marginBottom: 16 }}>
              tap <strong>Share</strong> → <strong>Add to Home Screen</strong>.
              open the ripple app from there → tap 🔔 pings → allow notifications.
              now you&apos;ll get pinged when the other is rippling.
            </p>
            <p style={{ fontSize: 12, opacity: 0.5 }}>tap anywhere to close</p>
          </div>
        </div>
      )}

      <style jsx global>{`
        @keyframes pop {
          0% { transform: scale(0.6); opacity: 0; }
          50% { transform: scale(1.15); opacity: 1; }
          100% { transform: scale(1); opacity: 1; }
        }
      `}</style>
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

function drawRipple(
  ctx: CanvasRenderingContext2D,
  opts: {
    x: number;
    y: number;
    r: number;
    intensity: number;
    progress: number;
    user: User;
    ghost?: boolean;
    fade?: number;
    breakTarget?: boolean;
    label?: string;
  }
) {
  const pal = PALETTE[opts.user];
  const fade = opts.fade ?? 1;
  const lifeAlpha = (1 - opts.progress) * fade;
  if (lifeAlpha <= 0) return;

  const [pr, pg, pb] = pal.primary;
  const [sr, sg, sb] = pal.secondary;

  const ringCount = 3 + Math.floor(opts.intensity * 4);
  for (let i = 0; i < ringCount; i++) {
    const t = i / ringCount;
    const radius = opts.r * (0.4 + t * 0.8);
    const w = 2 + opts.intensity * 6 * (1 - t);
    const a = lifeAlpha * (1 - t) * (opts.ghost ? 0.4 : 0.9);
    ctx.strokeStyle = `rgba(${pr},${pg},${pb},${a})`;
    ctx.lineWidth = w;
    ctx.beginPath();
    ctx.arc(opts.x, opts.y, radius, 0, Math.PI * 2);
    ctx.stroke();
  }

  const coreGrad = ctx.createRadialGradient(opts.x, opts.y, 0, opts.x, opts.y, opts.r * 0.6);
  coreGrad.addColorStop(0, `rgba(${sr},${sg},${sb},${lifeAlpha * 0.5})`);
  coreGrad.addColorStop(0.6, `rgba(${pr},${pg},${pb},${lifeAlpha * 0.25})`);
  coreGrad.addColorStop(1, `rgba(${pr},${pg},${pb},0)`);
  ctx.fillStyle = coreGrad;
  ctx.beginPath();
  ctx.arc(opts.x, opts.y, opts.r * 0.6, 0, Math.PI * 2);
  ctx.fill();

  if (pal.vibe === "epic") {
    const arcs = 2 + Math.floor(opts.intensity * 4);
    for (let i = 0; i < arcs; i++) {
      const ang = (i / arcs) * Math.PI * 2 + opts.progress * 2;
      const rr = opts.r * (0.7 + Math.random() * 0.3);
      const a = lifeAlpha * 0.6 * (opts.ghost ? 0.5 : 1);
      ctx.strokeStyle = `rgba(255,255,255,${a})`;
      ctx.lineWidth = 1.5;
      ctx.beginPath();
      let lastX = opts.x + Math.cos(ang) * opts.r * 0.2;
      let lastY = opts.y + Math.sin(ang) * opts.r * 0.2;
      ctx.moveTo(lastX, lastY);
      const segs = 6;
      for (let s = 1; s <= segs; s++) {
        const tr = (s / segs) * rr;
        const jitter = ((Math.random() - 0.5) * opts.r) / 6;
        const px = opts.x + Math.cos(ang) * tr + jitter;
        const py = opts.y + Math.sin(ang) * tr + jitter;
        ctx.lineTo(px, py);
      }
      ctx.stroke();
    }
  } else {
    const sparks = 4 + Math.floor(opts.intensity * 8);
    for (let i = 0; i < sparks; i++) {
      const ang = (i / sparks) * Math.PI * 2 + opts.progress * 1.2;
      const rad = opts.r * (0.6 + Math.sin(opts.progress * 6 + i) * 0.3);
      const px = opts.x + Math.cos(ang) * rad;
      const py = opts.y + Math.sin(ang) * rad;
      const a = lifeAlpha * 0.9 * (opts.ghost ? 0.5 : 1);
      drawStar(ctx, px, py, 3 + opts.intensity * 4, `rgba(255,240,245,${a})`);
    }
  }

  if (opts.label && opts.progress > 0.12 && opts.progress < 0.85) {
    const textAlpha = Math.sin(opts.progress * Math.PI) * lifeAlpha * 0.95;
    ctx.save();
    ctx.globalCompositeOperation = "source-over";
    const fs = Math.max(12, Math.min(28, opts.r * 0.28));
    ctx.font = `800 ${fs}px -apple-system, sans-serif`;
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.shadowColor = `rgba(${pr},${pg},${pb},0.9)`;
    ctx.shadowBlur = 18;
    ctx.fillStyle = `rgba(255,255,255,${textAlpha})`;
    ctx.fillText(opts.label, opts.x, opts.y);
    ctx.restore();
  }

  if (opts.breakTarget) {
    const a = 0.3 + Math.sin(performance.now() * 0.01) * 0.2;
    ctx.strokeStyle = `rgba(255,80,80,${a})`;
    ctx.lineWidth = 3;
    ctx.setLineDash([6, 6]);
    ctx.beginPath();
    ctx.arc(opts.x, opts.y, opts.r * 0.9, 0, Math.PI * 2);
    ctx.stroke();
    ctx.setLineDash([]);
  }
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

function drawHeart(ctx: CanvasRenderingContext2D, x: number, y: number, size: number, color: string, rot: number) {
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
