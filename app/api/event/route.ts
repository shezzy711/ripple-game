import { NextRequest, NextResponse } from "next/server";
import { pusherServer, CHANNEL } from "@/lib/pusher";

export const runtime = "nodejs";

const ALLOWED = new Set(["presence", "star", "bomb", "stroke-start", "stroke-points", "stroke-end", "egg"]);

export async function POST(req: NextRequest) {
  const body = (await req.json()) as { event?: string; data?: unknown };
  if (!body.event || !ALLOWED.has(body.event)) {
    return NextResponse.json({ ok: false, error: "invalid event" }, { status: 400 });
  }
  await pusherServer.trigger(CHANNEL, body.event, body.data ?? {});
  return NextResponse.json({ ok: true });
}
