import { NextRequest, NextResponse } from "next/server";
import { pusherServer, CHANNEL } from "@/lib/pusher";

export const runtime = "nodejs";

export async function POST(req: NextRequest) {
  const body = await req.json();
  await pusherServer.trigger(CHANNEL, "tap", body);
  return NextResponse.json({ ok: true });
}
