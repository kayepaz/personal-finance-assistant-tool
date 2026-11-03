-- Claims and triggers become a shared library: each can be attached to many theses.
-- Editing one changes it everywhere; a claim has one review schedule for all theses that use it.
-- (The migration runner turns foreign keys off around this file and checks them afterwards.)

CREATE TABLE thesis_claims (
  id             TEXT PRIMARY KEY,
  thesis_id      TEXT NOT NULL REFERENCES theses(id) ON DELETE CASCADE,
  claim_id       TEXT NOT NULL REFERENCES claims(id) ON DELETE CASCADE,
  attached_at    INTEGER NOT NULL,
  detached_at    INTEGER,
  detach_reason  TEXT NOT NULL DEFAULT ''
) STRICT;
CREATE UNIQUE INDEX thesis_claims_active ON thesis_claims(thesis_id, claim_id) WHERE detached_at IS NULL;
CREATE INDEX thesis_claims_by_claim ON thesis_claims(claim_id);

CREATE TABLE thesis_triggers (
  id             TEXT PRIMARY KEY,
  thesis_id      TEXT NOT NULL REFERENCES theses(id) ON DELETE CASCADE,
  trigger_id     TEXT NOT NULL REFERENCES triggers(id) ON DELETE CASCADE,
  attached_at    INTEGER NOT NULL,
  detached_at    INTEGER,
  detach_reason  TEXT NOT NULL DEFAULT ''
) STRICT;
CREATE UNIQUE INDEX thesis_triggers_active ON thesis_triggers(thesis_id, trigger_id) WHERE detached_at IS NULL;
CREATE INDEX thesis_triggers_by_trigger ON thesis_triggers(trigger_id);

-- Existing attachments. Each claim/trigger had exactly one thesis, so its (UUID v7) id is reused as the
-- attachment id: unique within each new table, and stable.
INSERT INTO thesis_claims(id, thesis_id, claim_id, attached_at)
  SELECT id, thesis_id, id, created_at FROM claims;
INSERT INTO thesis_triggers(id, thesis_id, trigger_id, attached_at)
  SELECT id, thesis_id, id, created_at FROM triggers;

-- Rebuild claims and triggers without thesis_id.
CREATE TABLE claims_new (
  id                 TEXT PRIMARY KEY,
  statement          TEXT NOT NULL,
  review_every_days  INTEGER NOT NULL CHECK (review_every_days > 0),
  next_review_on     TEXT NOT NULL,
  status             TEXT NOT NULL CHECK (status IN ('active','retired')),
  created_at         INTEGER NOT NULL,
  updated_at         INTEGER NOT NULL
) STRICT;
INSERT INTO claims_new SELECT id, statement, review_every_days, next_review_on, status, created_at, updated_at FROM claims;
DROP TABLE claims;
ALTER TABLE claims_new RENAME TO claims;

CREATE TABLE triggers_new (
  id          TEXT PRIMARY KEY,
  type        TEXT NOT NULL CHECK (type IN ('sell_on_date','sell_after_days','pct_change')),
  params      TEXT NOT NULL,
  label       TEXT NOT NULL DEFAULT '',
  status      TEXT NOT NULL CHECK (status IN ('active','retired')),
  created_at  INTEGER NOT NULL,
  updated_at  INTEGER NOT NULL
) STRICT;
INSERT INTO triggers_new SELECT id, type, params, label, status, created_at, updated_at FROM triggers;
DROP TABLE triggers;
ALTER TABLE triggers_new RENAME TO triggers;

-- Revisions: allow attach/detach history entries.
CREATE TABLE revisions_new (
  id           TEXT PRIMARY KEY,
  entity_type  TEXT NOT NULL CHECK (entity_type IN ('thesis','thesis_link','claim','trigger','thesis_claim','thesis_trigger')),
  entity_id    TEXT NOT NULL,
  revision_no  INTEGER NOT NULL,
  action       TEXT NOT NULL CHECK (action IN ('create','update','retire','unlink','attach','detach')),
  data         TEXT NOT NULL,
  note         TEXT NOT NULL DEFAULT '',
  created_at   INTEGER NOT NULL,
  UNIQUE (entity_type, entity_id, revision_no)
) STRICT;
INSERT INTO revisions_new SELECT * FROM revisions;
DROP TABLE revisions;
ALTER TABLE revisions_new RENAME TO revisions;
CREATE INDEX revisions_by_entity ON revisions(entity_type, entity_id);

-- Record the migrated attachments in history.
INSERT INTO revisions(id, entity_type, entity_id, revision_no, action, data, note, created_at)
  SELECT id, 'thesis_claim', id, 1, 'attach', json_object('thesis_id', thesis_id, 'claim_id', claim_id), '', attached_at
  FROM thesis_claims;
INSERT INTO revisions(id, entity_type, entity_id, revision_no, action, data, note, created_at)
  SELECT id, 'thesis_trigger', id, 1, 'attach', json_object('thesis_id', thesis_id, 'trigger_id', trigger_id), '', attached_at
  FROM thesis_triggers;
