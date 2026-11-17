import { ALERT_KIND_LABELS } from '@atlas/shared';
import { Button, Card, Field, Select } from '@/components/ui';
import type { AlertEditor } from './useAlertEditor';

export function RuleLibrary({ editor: e, chooseTemplate }: { editor: AlertEditor; chooseTemplate: () => void }) {
  return (
    <Card className="space-y-4 border-border-strong bg-surface-2 p-5">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h2 className="text-lg font-semibold">Your alert rules</h2>
          <p className="mt-1 text-sm text-text-2">
            {e.workspace.rules.length} rules · Choose who gets each alert and when.
          </p>
        </div>
        <Button variant="secondary" onClick={chooseTemplate}>
          Choose a template for a new rule
        </Button>
      </div>
      <Field label="Draft rule">
        {(p) => (
          <Select {...p} value={e.ruleId} onChange={(event) => e.selectRule(event.target.value)}>
            <option value="">Choose a rule</option>
            {e.workspace.rules.map((r) => (
              <option key={r.id} value={r.id}>
                {r.name} · {ALERT_KIND_LABELS[r.kind]}
                {r.replacesGeneral
                  ? ` (instead of all-client rules for ${r.clientIds.length} clients)`
                  : r.clientIds.length
                    ? ` (${r.clientIds.length} clients)`
                    : ' (all clients)'}
              </option>
            ))}
          </Select>
        )}
      </Field>
      {!e.workspace.rules.length && (
        <p className="rounded-lg border border-border-strong bg-surface p-4 text-sm text-text-2">
          Start in Templates, then choose Use in new rule on the message you want to send.
        </p>
      )}
      {e.rule && (
        <Button variant="ghost" onClick={e.removeRule}>
          Remove draft rule
        </Button>
      )}
    </Card>
  );
}
