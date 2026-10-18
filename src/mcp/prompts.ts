import type { McpServer } from '@modelcontextprotocol/server';
import { z } from 'zod';

import { calendarDaySchema, exportFolderSchema } from './schemas.js';

/**
 * MCP prompts: the server's slash commands. Claude Code lists this one as
 * `/mcp__cronometer__nutrient_radar`; Claude Desktop shows it in the attachment
 * menu.
 *
 * A prompt only writes a request for the model — it calls nothing itself. All the
 * arithmetic lives in the `nutrient_radar` tool, so the chart draws numbers the
 * server computed and the model never averages or rescales anything by hand.
 *
 * Arguments arrive as strings and are interpolated into the request, so each is
 * held to the same schema its tool argument uses. Nothing free-form gets in.
 */
const radarArguments = z.object({
  folder: exportFolderSchema.optional().describe('A downloaded export folder to read instead of the live diary.'),
  end_date: calendarDaySchema.optional().describe('Last day of the window, YYYY-MM-DD. Defaults to today (or the export’s last day).'),
  days: z
    .string()
    .regex(/^(?:[1-9]|[12]\d|3[01])$/, 'a whole number of days from 1 to 31')
    .optional()
    .describe('Days to average: up to 14 from the live diary, 31 from an export. Defaults to 7.'),
  profile: z
    .enum(['adult-male', 'adult-female'])
    .optional()
    .describe('Reference intakes to compare against. Defaults to adult-male.'),
});

export function radarPromptText(args: z.infer<typeof radarArguments>): string {
  const days = args.days ?? '7';
  const profile = args.profile ?? 'adult-male';
  const folderStep =
    args.folder === undefined
      ? 'Read the live diary (no folder argument).'
      : `Use the export folder \`${args.folder}\`.`;
  const folderArgument = args.folder === undefined ? '' : ` with that folder,`;
  const endArgument = args.end_date === undefined ? '' : `, end_date "${args.end_date}"`;

  return `Build my Cronometer micronutrient radar.

1. ${folderStep}
2. For the amino-acid references, call \`get_biometrics\` with metric_id 1 (Weight) for the 30 days ending on the radar's last day and take the most recent reading. Convert lbs to kg (× 0.45359237). If none is logged, leave body_weight_kg out — do not guess one.
3. Call \`nutrient_radar\`${folderArgument} days ${days}, profile "${profile}"${endArgument}, and body_weight_kg if you have it.
4. Render the result as an interactive React artifact using Recharts. Embed the tool's \`data\` object as a constant; do not recompute, round before display, or add nutrients.
   - Header: date range, "averaged over N logged days" (N = daysLogged.length), and a warning chip listing daysNotLogged when it is non-empty.
   - Tabs or a segmented control: All, Vitamins, Minerals, Essential amino acids (spoke.group). One RadarChart per selection, angle axis = spoke.label, radius = percent of reference, domain 0–200 with values above 200 drawn at 200 and marked "200%+".
   - A dashed reference ring at 100%.
   - kind "measured": plot percentOfReference as the filled series.
   - kind "incomplete": do NOT plot it as intake. Draw atLeastPercentOfReference as a separate hollow/dashed "at least" series, and label it so it reads as a floor.
   - kind "no-data": nothing logged in this window recorded it. Plot nothing for it — not 0, not a floor.
   - reference null (no body weight): leave the spoke unplotted and say why in its tooltip.
   - Tooltip per spoke: label, daily average with unit, reference amount and basis (RDA/AI/WHO-2007), percent, and coverage (coverage.groups.withData of coverage.groups.total — food entries when coverageUnit is "food-entry", diary groups otherwise).
   - Below the chart, a compact sortable table of the same rows, and a footnote with referenceSource, essentialNutrientsNotInExport ("not tracked here"), the labels of "no-data" spokes ("nothing logged recorded it"), any nutrientColumnsMissingFromExport ("column missing from this file"), and that these are population references, not personal targets.
   - Light and dark themes; readable at phone width.
5. In chat, give the artifact plus at most three neutral observations (e.g. which spokes are incomplete or have no data, which days were unlogged). Report logged intake only: no diagnosis, deficiency claims, or supplement advice.`;
}

export function registerPrompts(server: McpServer): void {
  server.registerPrompt(
    'nutrient_radar',
    {
      title: 'Micronutrient Radar',
      description:
        'Average the last 7 days of the diary across 31 essential vitamins, minerals and amino acids and render it as an interactive radar chart artifact.',
      argsSchema: radarArguments,
    },
    (args) => ({
      messages: [{ role: 'user', content: { type: 'text', text: radarPromptText(args) } }],
    }),
  );
}
