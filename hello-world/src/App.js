import { useState } from 'react';
import WaterReflectionContours from './WaterReflectionContours';
import WhiskeyGlass from './WhiskeyGlass';
import LiquidMacro from './LiquidMacro';

const TABS = [
  ['reflection', 'Lake Reflections'],
  ['whiskey', 'Whiskey Glass'],
  ['macro', 'Liquid Macro'],
];

function App() {
  const [tab, setTab] = useState('reflection');
  return (
    <div style={{ background: '#0b0f14', minHeight: '100vh' }}>
      <nav style={{ display: 'flex', gap: 8, padding: '10px 16px 0',
        maxWidth: 1180 + 32, margin: '0 auto', boxSizing: 'border-box' }}>
        {TABS.map(([id, label]) => (
          <button key={id} onClick={() => setTab(id)}
            style={{ padding: '9px 16px', fontSize: 12, borderRadius: 9, cursor: 'pointer',
              fontFamily: 'ui-monospace, monospace', letterSpacing: 0.5,
              background: tab === id ? '#27424b' : '#141b23',
              color: tab === id ? '#dff1f6' : '#8fa2b3',
              border: '1px solid ' + (tab === id ? '#3f7e8f' : '#232d38') }}>
            {label}
          </button>
        ))}
      </nav>
      {tab === 'reflection' ? <WaterReflectionContours />
        : tab === 'whiskey' ? <WhiskeyGlass />
        : <LiquidMacro />}
    </div>
  );
}

export default App;
