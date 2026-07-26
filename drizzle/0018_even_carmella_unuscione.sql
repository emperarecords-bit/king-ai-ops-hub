ALTER TABLE "work_items" ALTER COLUMN "condition" DROP DEFAULT;--> statement-breakpoint
ALTER TABLE "work_items" ALTER COLUMN "condition" DROP NOT NULL;--> statement-breakpoint
-- Legacy-condition integrity: every existing Work Item got 'planned' from 0017's NOT-NULL
-- default, which is a DB default masquerading as a real operational condition. This feature
-- shipped moments ago, so no condition has been genuinely established yet. Reset all rows to
-- NULL (= "Unknown", pending human review). New/edited items write an explicit condition.
UPDATE "work_items" SET "condition" = NULL;
