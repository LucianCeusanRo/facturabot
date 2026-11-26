import type { Insight } from '../../shared/types';
import { Icon } from '../components/Icon';

const ICON: Record<Insight['kind'], string> = { missing: 'search', due: 'calendar', overdue: 'alert', threshold: 'tax' };

/** Observații pe reguli: facturi lipsă, scadențe, praguri TVA. */
export function InsightsList({ items, compact }: { items: Insight[]; compact?: boolean }) {
  if (!items.length) return null;
  return (
    <div className={`insights ${compact ? 'compact' : ''}`}>
      {items.map((i) => (
        <div key={i.id} className={`insight ${i.level}`}>
          <Icon name={ICON[i.kind]} size={16} />
          <div className="grow">
            <div className="row-title">{i.title}</div>
            <div className="hint">{i.detail}</div>
          </div>
        </div>
      ))}
    </div>
  );
}
