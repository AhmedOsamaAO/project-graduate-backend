import type { PrismaClient } from '../generated/prisma/client';

/** Refuse privileged/misconfigured runtime connections rather than weakening history. */
export async function assertRuntimeRole(prisma: PrismaClient): Promise<void> {
  const [result] = await prisma.$queryRaw<Array<{ safe: boolean }>>`
    SELECT (
      CASE
        WHEN current_user <> session_user THEN false
        ELSE (
          r.rolcanlogin
          AND r.rolname <> 'graduate_runtime'
          AND NOT r.rolsuper AND NOT r.rolcreatedb AND NOT r.rolcreaterole
          AND NOT r.rolreplication AND NOT r.rolbypassrls
          AND pg_has_role(session_user, 'graduate_runtime', 'USAGE')
          AND has_table_privilege(session_user, 'public.change_history', 'SELECT')
          AND has_table_privilege(session_user, 'public.change_history', 'INSERT')
          AND NOT has_table_privilege(session_user, 'public.change_history', 'UPDATE')
          AND NOT has_any_column_privilege(session_user, 'public.change_history', 'UPDATE')
          AND NOT has_table_privilege(session_user, 'public.change_history', 'DELETE')
          AND NOT has_table_privilege(session_user, 'public.change_history', 'TRUNCATE')
          AND NOT has_table_privilege(session_user, 'public.change_history', 'TRIGGER')
          AND has_sequence_privilege(session_user, 'public.change_history_id_seq', 'USAGE')
          AND NOT has_sequence_privilege(session_user, 'public.change_history_id_seq', 'UPDATE')
          AND NOT has_table_privilege(session_user, 'public.staff_user', 'DELETE')
          AND NOT has_table_privilege(session_user, 'public.staff_user', 'TRUNCATE')
          AND NOT has_schema_privilege(session_user, 'public', 'CREATE')
          AND NOT EXISTS (
            SELECT 1 FROM pg_roles p
            WHERE pg_has_role(session_user, p.oid, 'MEMBER') AND (
              p.rolname NOT IN (session_user, 'graduate_runtime')
              OR (p.rolname = 'graduate_runtime' AND p.rolcanlogin)
              OR p.rolsuper OR p.rolcreaterole OR p.rolcreatedb OR p.rolreplication OR p.rolbypassrls
              OR p.oid = (SELECT relowner FROM pg_class WHERE oid = 'public.change_history'::regclass)
              OR p.oid = (SELECT relowner FROM pg_class WHERE oid = 'public.change_history_id_seq'::regclass)
              OR p.oid = (SELECT relowner FROM pg_class WHERE oid = 'public.staff_user'::regclass)
              OR p.oid = (SELECT datdba FROM pg_database WHERE datname = current_database())
              OR p.oid = (SELECT nspowner FROM pg_namespace WHERE nspname = 'public')
            )
          )
        )
      END
    ) AS safe FROM pg_roles r WHERE r.rolname = session_user
  `;
  if (!result?.safe)
    throw new Error('Runtime database role does not protect change history');
}
