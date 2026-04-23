import { NextRequest, NextResponse } from "next/server";
import webpush, { PushSubscription as WPSubscription } from "web-push";

export const runtime = "nodejs";

const publicKey = process.env.NEXT_PUBLIC_VAPID_PUBLIC_KEY;
const privateKey = process.env.VAPID_PRIVATE_KEY;
const contact = process.env.VAPID_CONTACT || "mailto:hello@ripple.app";

if (publicKey && privateKey) {
  webpush.setVapidDetails(contact, publicKey, privateKey);
}

export async function POST(req: NextRequest) {
  if (!publicKey || !privateKey) {
    return NextResponse.json({ ok: false, error: "VAPID not configured" }, { status: 500 });
  }
  const { subscription, payload } = (await req.json()) as {
    subscription: WPSubscription;
    payload: unknown;
  };
  if (!subscription?.endpoint) {
    return NextResponse.json({ ok: false, error: "missing subscription" }, { status: 400 });
  }
  try {
    await webpush.sendNotification(subscription, JSON.stringify(payload ?? {}));
    return NextResponse.json({ ok: true });
  } catch (err: unknown) {
    const e = err as { statusCode?: number; body?: string };
    return NextResponse.json(
      { ok: false, error: e.body || "send failed", statusCode: e.statusCode ?? 500 },
      { status: e.statusCode ?? 500 }
    );
  }
}
