'use client';

import { useMemo, useState } from 'react';

const players = [
  { name: 'Carlos Alcaraz', tour: 'ATP', rank: 1, country: 'Spain', flag: '🇪🇸', event: 'US Open', city: 'New York', date: 'Aug 24–Sep 6', status: 'Confirmed', form: '9–1' },
  { name: 'Jannik Sinner', tour: 'ATP', rank: 2, country: 'Italy', flag: '🇮🇹', event: 'US Open', city: 'New York', date: 'Aug 24–Sep 6', status: 'Expected', form: '8–2' },
  { name: 'Coco Gauff', tour: 'WTA', rank: 3, country: 'United States', flag: '🇺🇸', event: 'US Open', city: 'New York', date: 'Aug 24–Sep 6', status: 'Confirmed', form: '7–3' },
  { name: 'Iga Świątek', tour: 'WTA', rank: 2, country: 'Poland', flag: '🇵🇱', event: 'US Open', city: 'New York', date: 'Aug 24–Sep 6', status: 'Expected', form: '8–2' },
];

const starterGoals = [
  { id: 1, title: 'Build a reliable second serve', category: 'Technique', progress: 72, target: '8 of 10 serves in', streak: 6 },
  { id: 2, title: 'Play three matches this month', category: 'Competition', progress: 67, target: '2 of 3 matches', streak: 2 },
  { id: 3, title: 'Recover like a pro', category: 'Wellness', progress: 45, target: '9 of 20 sessions', streak: 4 },
];

export default function Home() {
  const [tab, setTab] = useState<'players' | 'goals'>('players');
  const [query, setQuery] = useState('');
  const [tour, setTour] = useState('ALL');
  const [goals, setGoals] = useState(starterGoals);
  const visiblePlayers = useMemo(() => players.filter((player) => {
    const matchesTour = tour === 'ALL' || player.tour === tour;
    const haystack = `${player.name} ${player.country} ${player.event} ${player.city}`.toLowerCase();
    return matchesTour && haystack.includes(query.toLowerCase());
  }), [query, tour]);

  function nudgeGoal(id: number) {
    setGoals((items) => items.map((goal) => goal.id === id ? { ...goal, progress: Math.min(100, goal.progress + 5) } : goal));
  }

  return (
    <main>
      <header className="site-header">
        <a className="brand" href="#top" aria-label="TennisMoon home"><span className="brand-mark">◒</span><span>TENNISMOON</span></a>
        <nav aria-label="Primary navigation">
          <button className={tab === 'players' ? 'active' : ''} onClick={() => setTab('players')}>Player Radar</button>
          <button className={tab === 'goals' ? 'active' : ''} onClick={() => setTab('goals')}>My Moonshot</button>
        </nav>
        <button className="member-button" onClick={() => setTab('goals')}>My dashboard <span>↗</span></button>
      </header>

      {tab === 'players' ? (
        <>
          <section className="hero" id="top">
            <div className="eyebrow"><span className="live-dot" /> LIVE PLAYER INTELLIGENCE</div>
            <h1>KNOW THEIR<br/><em>NEXT MOVE.</em></h1>
            <p>Follow the next publicly reported tournament stop for the players shaping the game. Clear status. Source-ready facts. Zero private travel tracking.</p>
            <div className="hero-orbit" aria-hidden="true"><span>TM</span></div>
          </section>

          <section className="tracker-section" aria-labelledby="tracker-heading">
            <div className="section-heading"><div><span>01 / PLAYER RADAR</span><h2 id="tracker-heading">WHO’S LANDING WHERE?</h2></div><p>Schedules change. Confirm details with official tournament and tour sources before making plans.</p></div>
            <div className="filters">
              <label><span className="sr-only">Search players and events</span><input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Search player, country, city or event" /></label>
              <div className="tour-filter" role="group" aria-label="Tour filter">{['ALL','ATP','WTA'].map((item) => <button key={item} className={tour === item ? 'selected' : ''} onClick={() => setTour(item)}>{item}</button>)}</div>
              <button className="refresh-button">↻ Refresh data</button>
            </div>
            <div className="player-grid">
              {visiblePlayers.map((player) => (
                <article className="player-card" key={player.name}>
                  <div className="card-top"><span className="tour-badge">{player.tour} #{player.rank}</span><span className={`status ${player.status.toLowerCase()}`}>{player.status}</span></div>
                  <div className="player-name"><span>{player.flag}</span><div><h3>{player.name}</h3><p>{player.country}</p></div></div>
                  <div className="next-stop"><small>NEXT REPORTED STOP</small><strong>{player.event}</strong><span>{player.city} · {player.date}</span></div>
                  <div className="card-footer"><span>Recent form <b>{player.form}</b></span><button>Facts & sources ↗</button></div>
                </article>
              ))}
            </div>
          </section>
        </>
      ) : (
        <section className="goals-page" id="top">
          <div className="goal-intro"><div className="eyebrow"><span className="live-dot pink" /> PERSONAL PERFORMANCE SYSTEM</div><h1>MAKE YOUR<br/><em>MOONSHOT.</em></h1><p>Turn the player you want to become into a plan you can work today. Track practice, matches, recovery and mindset in one private dashboard.</p><button className="primary-action">+ Create a new goal</button></div>
          <div className="score-card"><small>YOUR CURRENT ORBIT</small><strong>{Math.round(goals.reduce((sum, goal) => sum + goal.progress, 0) / goals.length)}%</strong><div className="orbit-ring"><span>3</span><small>ACTIVE<br/>GOALS</small></div><p>Keep showing up. Small wins create escape velocity.</p></div>
          <div className="goals-board">
            <div className="section-heading"><div><span>02 / MY MOONSHOT</span><h2>GOALS IN MOTION</h2></div><p>Private to your account. Progress is saved across sessions.</p></div>
            <div className="goal-list">{goals.map((goal) => (
              <article className="goal-card" key={goal.id}>
                <div className="goal-meta"><span>{goal.category}</span><b>{goal.streak} day streak</b></div>
                <h3>{goal.title}</h3><p>{goal.target}</p>
                <div className="progress-row"><div className="progress-track"><span style={{width: `${goal.progress}%`}} /></div><strong>{goal.progress}%</strong></div>
                <button onClick={() => nudgeGoal(goal.id)}>Log progress +5%</button>
              </article>
            ))}</div>
          </div>
        </section>
      )}

      <footer><span>◒ TENNISMOON</span><p>Unofficial fan experience. Public schedule intelligence only.</p><a href="https://tennismoon.com">tennismoon.com ↗</a></footer>
    </main>
  );
}

