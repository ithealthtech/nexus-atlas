import { Link } from '@tanstack/react-router';
import { Compass } from 'lucide-react';
import { Card, EmptyState } from '@/components/ui';

export function NotFound() {
  return (
    <div className="mx-auto max-w-lg p-8">
      <Card>
        <EmptyState
          icon={Compass}
          title="Page not found"
          description="That page doesn't exist, or you don't have access to it."
          action={
            <Link to="/" className="font-semibold text-primary hover:underline">
              Go to the dashboard
            </Link>
          }
        />
      </Card>
    </div>
  );
}
