ALTER TABLE "programs" DISABLE ROW LEVEL SECURITY;--> statement-breakpoint
UPDATE "programs"
SET
	"approver_name" = 'Шальнов И.П.',
	"approver_title" = 'Начальник Института',
	"signer_name" = 'Ветров В.В.',
	"signer_title" = 'Начальник учебного отдела',
	"updated_at" = now()
WHERE "title" IN (
	'ДЕМО — Переподготовка: охрана труда (утверждено)',
	'ДЕМО — Охрана труда: две группы (есть накладки)'
);--> statement-breakpoint
ALTER TABLE "programs" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "programs" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "schedule_versions" DISABLE ROW LEVEL SECURITY;--> statement-breakpoint
UPDATE "schedule_versions"
SET "snapshot" = jsonb_set(
	"snapshot",
	'{program}',
	COALESCE("snapshot"->'program', '{}'::jsonb) || jsonb_build_object(
		'approver_name', 'Шальнов И.П.',
		'approver_title', 'Начальник Института',
		'signer_name', 'Ветров В.В.',
		'signer_title', 'Начальник учебного отдела'
	),
	true
)
WHERE "program_title" = 'ДЕМО — Переподготовка: охрана труда (утверждено)'
	AND "snapshot" ? 'program';--> statement-breakpoint
ALTER TABLE "schedule_versions" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "schedule_versions" FORCE ROW LEVEL SECURITY;
