import { Card, CardHeader } from '@/components/ui';

export function MenuStylePicker() {
  return (
    <Card>
      <CardHeader
        title="Navigation"
        description="Atlas uses one sidebar with workspace tabs. Search is always available in the header."
      />
      <p className="px-5 pt-2 pb-5 text-sm text-muted">
        Use Collapse sidebar at the bottom of the menu to give your workspace more room. Atlas remembers your choice in
        this browser. On phones, use Open navigation in the header.
      </p>
    </Card>
  );
}
