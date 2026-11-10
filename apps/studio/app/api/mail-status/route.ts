import { NextRequest, NextResponse } from "next/server";
import { isFailure, requireUser } from "@/lib/guard";
import { mailConfig } from "@/lib/mail";

/**
 * GET /api/mail-status — CAN THIS INSTANCE SEND MAIL, AND TO WHOM (2026-11-10).
 *
 * The Studio's Distribution panel needs three facts before its "send invitations" button can say what it will do:
 * is mail configured, can it reach real recipients (only in production), and — outside production — the one address
 * everything is redirected to. It used to read them from /api/platform, which is now for platform administrators
 * only; this answers just those three, to any signed-in user, and nothing else about the instance.
 */
export async function GET(req: NextRequest) {
  const resolved = await requireUser(req);
  if (isFailure(resolved)) return resolved.response;
  const cfg = mailConfig();
  return NextResponse.json({
    mail: {
      configured: cfg.configured,
      canReachRealRecipients: cfg.configured && cfg.tier === "production",
      redirectTo: cfg.redirectTo,
    },
  }, { headers: { "cache-control": "no-store" } });
}
