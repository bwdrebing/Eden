import { useState } from 'react';
import WaterReflectionContours from './WaterReflectionContours';
import SandscapeStudio from './SandscapeStudio';
import { useUrlSync } from './urlSettings';

// The two studios. Each owns its whole page — its own workspaces, its own
// slice of the URL — and this switch is the only thing they share. It sits
// on each studio's caption line rather than in a bar above both, so it
// costs neither studio's control column any of its one-screen budget. The
// studio in view rides in the URL too, so a shared link opens on the right
// one; a link from before there was a choice has no "app" slice and opens
// on the water, as it always did.
export const STUDIOS = [
  { id: 'water', name: 'Water', icon: '≈' },
  { id: 'sand', name: 'Sand', icon: '∿' },
];

function StudioSwitch({ value, onChange }) {
  return (
    <div role="tablist" aria-label="Studio" style={{ display: 'flex', gap: 4 }}>
      {STUDIOS.map((s) => {
        const on = s.id === value;
        return (
          <button key={s.id} role="tab" aria-selected={on} onClick={() => onChange(s.id)}
            style={{ padding: '0 9px', borderRadius: 8, cursor: 'pointer', fontSize: 10,
              lineHeight: '11px', letterSpacing: 0.6, fontFamily: 'ui-monospace, monospace',
              background: on ? '#242d35' : 'none', color: on ? '#e6eef5' : '#6f8294',
              border: '1px solid ' + (on ? '#51606d' : '#26313c') }}>
            {s.icon} {s.name}
          </button>
        );
      })}
    </div>
  );
}

function App() {
  const [studio, setStudio] = useState('water');
  useUrlSync('app', { studio: [studio, setStudio] });
  const current = STUDIOS.some((s) => s.id === studio) ? studio : 'water';
  const sw = <StudioSwitch value={current} onChange={setStudio} />;
  return current === 'sand'
    ? <SandscapeStudio studioSwitch={sw} />
    : <WaterReflectionContours studioSwitch={sw} />;
}

export default App;
