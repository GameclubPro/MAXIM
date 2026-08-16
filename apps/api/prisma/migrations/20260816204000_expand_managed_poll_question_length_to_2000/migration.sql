ALTER TABLE "managed_polls"
  DROP CONSTRAINT "managed_polls_question_length_check",
  ADD CONSTRAINT "managed_polls_question_length_check"
    CHECK (char_length(btrim("question")) BETWEEN 1 AND 2000);
