import { ROLE_INFO, type AlertRule, type ClientSummary, type UserView } from '@atlas/shared';
import { Checkbox } from '@/components/ui';

type Choice = { id: string; label: string };
function Selection({
  title,
  description,
  options,
  selected,
  missing,
  change,
}: {
  title: string;
  description: string;
  options: Choice[];
  selected: string[];
  missing: string;
  change: (ids: string[]) => void;
}) {
  const unavailable = selected
    .filter((id) => !options.some((o) => o.id === id))
    .map((id, index) => ({ id, label: `${missing} ${index + 1} — remove selection` }));
  return (
    <fieldset className="space-y-3">
      <legend className="mb-2 text-sm font-semibold text-text">{title}</legend>
      <p className="text-xs text-muted">{description}</p>
      <div className="grid max-h-48 gap-3 overflow-auto sm:grid-cols-2">
        {[...options, ...unavailable].map((option) => (
          <Checkbox
            key={option.id}
            label={option.label}
            checked={selected.includes(option.id)}
            onChange={() =>
              change(
                selected.includes(option.id) ? selected.filter((id) => id !== option.id) : [...selected, option.id],
              )
            }
          />
        ))}
      </div>
    </fieldset>
  );
}

export function Audience({
  rule,
  clients,
  users,
  change,
}: {
  rule: AlertRule;
  clients: ClientSummary[];
  users: UserView[];
  change: (r: AlertRule) => void;
}) {
  const staff = users.filter((u) => (!u.disabled && ROLE_INFO[u.role].staff) || rule.emailUserIds.includes(u.id));
  return (
    <>
      <Selection
        title="Clients"
        description="No selection means all clients. Remove unavailable selections before saving."
        options={clients.map((c) => ({ id: c.id, label: c.name }))}
        selected={rule.clientIds}
        missing="Unavailable client"
        change={(clientIds) => change({ ...rule, clientIds })}
      />
      <Selection
        title="Email recipients"
        description="Active staff members. The preview checks each person's client access."
        options={staff.map((u) => ({
          id: u.id,
          label: !u.disabled && ROLE_INFO[u.role].staff ? u.name : `${u.name} (unavailable — remove selection)`,
        }))}
        selected={rule.emailUserIds}
        missing="Unavailable staff member"
        change={(emailUserIds) => change({ ...rule, emailUserIds })}
      />
    </>
  );
}
