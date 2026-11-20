import type { PrismaClient } from '../generated/prisma/client';

/** Deletes idle-expired, absolute-expired, deactivated-user, and stale-version sessions. */
export async function cleanupExpiredSessions(
  prisma: PrismaClient,
  sessionIdleTimeoutMinutes: number,
  now: Date = new Date(),
): Promise<{ readonly deletedCount: number }> {
  const idleCutoff = new Date(
    now.getTime() - sessionIdleTimeoutMinutes * 60_000,
  );

  const deletedCount = await prisma.$executeRaw`
    DELETE FROM staff_session
    WHERE absolute_expires_at <= ${now}
      OR last_seen_at <= ${idleCutoff}
      OR EXISTS (
        SELECT 1
        FROM staff_user u
        WHERE u.id = staff_session.staff_user_id
          AND (u.deactivated_at IS NOT NULL OR u.auth_version <> staff_session.auth_version)
      )
  `;

  return { deletedCount: Number(deletedCount) };
}
