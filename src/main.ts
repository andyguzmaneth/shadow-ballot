import './style.css';

type TabId = 'voter' | 'coordinator' | 'explorer';

const TABS: { id: TabId; label: string }[] = [
  { id: 'voter', label: 'Voter' },
  { id: 'coordinator', label: 'Coordinator' },
  { id: 'explorer', label: 'Explorer' },
];

function renderApp(): void {
  const app = document.querySelector<HTMLDivElement>('#app')!;

  app.innerHTML = `
    <header class="header">
      <h1><span>Shadow</span> Ballot</h1>
      <p class="tagline">Private voting hidden in plain sight</p>
    </header>

    <nav class="tab-nav">
      ${TABS.map(
        (t) =>
          `<button class="tab-btn${t.id === 'voter' ? ' active' : ''}" data-tab="${t.id}">${t.label}</button>`,
      ).join('')}
    </nav>

    <main class="content">
      <div id="panel-voter" class="tab-panel active">
        <div class="panel-placeholder">
          <h2>Voter</h2>
          <p>Cast your vote as a normal ETH transfer. No one can tell you voted.</p>
        </div>
      </div>
      <div id="panel-coordinator" class="tab-panel">
        <div class="panel-placeholder">
          <h2>Coordinator</h2>
          <p>Scan stealth transactions, decode hidden votes, and publish results on-chain.</p>
        </div>
      </div>
      <div id="panel-explorer" class="tab-panel">
        <div class="panel-placeholder">
          <h2>Explorer</h2>
          <p>Paste any transaction hash and reveal the vote hidden inside a normal transfer.</p>
        </div>
      </div>
    </main>

    <footer class="footer">
      Hackathon 2026 &mdash; Anamorphic Signatures + Stealth Addresses
    </footer>
  `;

  initTabs();
}

function initTabs(): void {
  const buttons = document.querySelectorAll<HTMLButtonElement>('.tab-btn');
  const panels = document.querySelectorAll<HTMLDivElement>('.tab-panel');

  buttons.forEach((btn) => {
    btn.addEventListener('click', () => {
      const tabId = btn.dataset.tab as TabId;

      buttons.forEach((b) => b.classList.remove('active'));
      btn.classList.add('active');

      panels.forEach((p) => p.classList.remove('active'));
      document.getElementById(`panel-${tabId}`)?.classList.add('active');
    });
  });
}

renderApp();
