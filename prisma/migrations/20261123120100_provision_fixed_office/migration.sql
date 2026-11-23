DO $$
DECLARE
  existing_inst RECORD;
  existing_fac RECORD;
  conflicting_fac_id INTEGER;
  inst_max INTEGER;
  fac_max INTEGER;
  seq_last BIGINT;
  seq_called BOOLEAN;
BEGIN
  SELECT id, name, institution_type
  INTO existing_inst
  FROM educational_institution
  WHERE id = 1
  FOR UPDATE;

  IF FOUND THEN
    IF existing_inst.name IS DISTINCT FROM 'Zagazig University'
       OR existing_inst.institution_type IS DISTINCT FROM 'PUBLIC_UNIVERSITY'::institution_type THEN
      RAISE EXCEPTION 'Conflicting educational_institution row at reserved id = 1';
    END IF;
  ELSE
    INSERT INTO educational_institution (id, name, institution_type, version, created_at, updated_at)
    VALUES (1, 'Zagazig University', 'PUBLIC_UNIVERSITY'::institution_type, 1, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP);
  END IF;

  SELECT id, institution_id, name
  INTO existing_fac
  FROM faculty
  WHERE id = 1
  FOR UPDATE;

  IF FOUND THEN
    IF existing_fac.institution_id IS DISTINCT FROM 1
       OR existing_fac.name IS DISTINCT FROM 'Faculty of Computer and Information' THEN
      RAISE EXCEPTION 'Conflicting faculty row at reserved id = 1';
    END IF;
  ELSE
    SELECT id INTO conflicting_fac_id
    FROM faculty
    WHERE institution_id = 1 AND name = 'Faculty of Computer and Information'
    FOR UPDATE;

    IF FOUND THEN
      RAISE EXCEPTION 'Conflicting faculty row for fixed office exists at non-reserved id = %', conflicting_fac_id;
    END IF;

    INSERT INTO faculty (id, institution_id, name, version, created_at, updated_at)
    VALUES (1, 1, 'Faculty of Computer and Information', 1, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP);
  END IF;

  SELECT COALESCE(MAX(id), 1) INTO inst_max FROM educational_institution;
  SELECT last_value, is_called INTO seq_last, seq_called FROM educational_institution_id_seq;
  IF NOT seq_called OR seq_last < inst_max THEN
    PERFORM setval('educational_institution_id_seq', inst_max, true);
  END IF;

  SELECT COALESCE(MAX(id), 1) INTO fac_max FROM faculty;
  SELECT last_value, is_called INTO seq_last, seq_called FROM faculty_id_seq;
  IF NOT seq_called OR seq_last < fac_max THEN
    PERFORM setval('faculty_id_seq', fac_max, true);
  END IF;
END $$;
