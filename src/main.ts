import './style.css';
import { initVoterView } from './views/voter.js';
import { initCoordinatorView } from './views/coordinator.js';
import { initExplorerView } from './views/explorer.js';

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
      <div id="panel-voter" class="tab-panel active"></div>
      <div id="panel-coordinator" class="tab-panel"></div>
      <div id="panel-explorer" class="tab-panel"></div>
    </main>

    <footer class="footer">
      Hackathon 2026 &mdash; Anamorphic Signatures + Stealth Addresses
    </footer>
  `;

  initTabs();
  initVoterView();
  initCoordinatorView();
  initExplorerView();
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
