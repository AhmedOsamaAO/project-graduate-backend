ALTER TYPE "history_action" ADD VALUE 'SIGN_IN';
ALTER TYPE "history_action" ADD VALUE 'SIGN_IN_FAILED';
ALTER TYPE "history_action" ADD VALUE 'PASSWORD_CHANGED';

CREATE INDEX staff_session_last_seen_at_idx ON staff_session(last_seen_at);
