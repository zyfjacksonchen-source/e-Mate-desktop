-- Block late metadata writes from in-flight old Worker requests before the final export.

-- Read back all 18 definitions; HTTP read-only mode alone is not a database freeze.

CREATE TRIGGER emate218_hold_skill_hub_skills_insert
BEFORE INSERT ON skill_hub_skills
BEGIN SELECT RAISE(ABORT, 'EM218_MIGRATION_HOLD'); END;

CREATE TRIGGER emate218_hold_skill_hub_skills_update
BEFORE UPDATE ON skill_hub_skills
BEGIN SELECT RAISE(ABORT, 'EM218_MIGRATION_HOLD'); END;

CREATE TRIGGER emate218_hold_skill_hub_skills_delete
BEFORE DELETE ON skill_hub_skills
BEGIN SELECT RAISE(ABORT, 'EM218_MIGRATION_HOLD'); END;

CREATE TRIGGER emate218_hold_skill_hub_versions_insert
BEFORE INSERT ON skill_hub_versions
BEGIN SELECT RAISE(ABORT, 'EM218_MIGRATION_HOLD'); END;

CREATE TRIGGER emate218_hold_skill_hub_versions_update
BEFORE UPDATE ON skill_hub_versions
BEGIN SELECT RAISE(ABORT, 'EM218_MIGRATION_HOLD'); END;

CREATE TRIGGER emate218_hold_skill_hub_versions_delete
BEFORE DELETE ON skill_hub_versions
BEGIN SELECT RAISE(ABORT, 'EM218_MIGRATION_HOLD'); END;

CREATE TRIGGER emate218_hold_skill_hub_publication_tombstones_insert
BEFORE INSERT ON skill_hub_publication_tombstones
BEGIN SELECT RAISE(ABORT, 'EM218_MIGRATION_HOLD'); END;

CREATE TRIGGER emate218_hold_skill_hub_publication_tombstones_update
BEFORE UPDATE ON skill_hub_publication_tombstones
BEGIN SELECT RAISE(ABORT, 'EM218_MIGRATION_HOLD'); END;

CREATE TRIGGER emate218_hold_skill_hub_publication_tombstones_delete
BEFORE DELETE ON skill_hub_publication_tombstones
BEGIN SELECT RAISE(ABORT, 'EM218_MIGRATION_HOLD'); END;

CREATE TRIGGER emate218_hold_skill_hub_mutation_requests_insert
BEFORE INSERT ON skill_hub_mutation_requests
BEGIN SELECT RAISE(ABORT, 'EM218_MIGRATION_HOLD'); END;

CREATE TRIGGER emate218_hold_skill_hub_mutation_requests_update
BEFORE UPDATE ON skill_hub_mutation_requests
BEGIN SELECT RAISE(ABORT, 'EM218_MIGRATION_HOLD'); END;

CREATE TRIGGER emate218_hold_skill_hub_mutation_requests_delete
BEFORE DELETE ON skill_hub_mutation_requests
BEGIN SELECT RAISE(ABORT, 'EM218_MIGRATION_HOLD'); END;

CREATE TRIGGER emate218_hold_skill_hub_install_intents_insert
BEFORE INSERT ON skill_hub_install_intents
BEGIN SELECT RAISE(ABORT, 'EM218_MIGRATION_HOLD'); END;

CREATE TRIGGER emate218_hold_skill_hub_install_intents_update
BEFORE UPDATE ON skill_hub_install_intents
BEGIN SELECT RAISE(ABORT, 'EM218_MIGRATION_HOLD'); END;

CREATE TRIGGER emate218_hold_skill_hub_install_intents_delete
BEFORE DELETE ON skill_hub_install_intents
BEGIN SELECT RAISE(ABORT, 'EM218_MIGRATION_HOLD'); END;

CREATE TRIGGER emate218_hold_skill_hub_install_logs_insert
BEFORE INSERT ON skill_hub_install_logs
BEGIN SELECT RAISE(ABORT, 'EM218_MIGRATION_HOLD'); END;

CREATE TRIGGER emate218_hold_skill_hub_install_logs_update
BEFORE UPDATE ON skill_hub_install_logs
BEGIN SELECT RAISE(ABORT, 'EM218_MIGRATION_HOLD'); END;

CREATE TRIGGER emate218_hold_skill_hub_install_logs_delete
BEFORE DELETE ON skill_hub_install_logs
BEGIN SELECT RAISE(ABORT, 'EM218_MIGRATION_HOLD'); END;
