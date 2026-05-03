import { useState, useRef, useEffect } from 'react'

type IconStatus = boolean | 'warn'

interface Token {
  name: string
  chain: string
  addr: string
  price: string
  change: string
  vol: string
  liq: string
  safety: number
  lp: IconStatus
  sniper: IconStatus
}

interface ChatMessage {
  role: 'agent' | 'user'
  text: string
}

const TOKENS: Token[] = [
  { name: 'BONK',     chain: 'Solana',   addr: '7GC1hg...W2hr',   price: '$0.000018',   change: '+42.3%', vol: '$2.4M',  liq: '$4.2M',  safety: 61, lp: true,   sniper: true   },
  { name: 'PEPE2',    chain: 'Ethereum', addr: '0x1f98...F984',   price: '$0.000420',   change: '-12.1%', vol: '$890K', liq: '$1.1M',  safety: 34, lp: false,  sniper: 'warn' },
  { name: 'SLERF',    chain: 'Solana',   addr: '9xQeW...3kPz',   price: '$0.8200',     change: '+8.7%',  vol: '$5.6M',  liq: '$12.4M', safety: 78, lp: true,   sniper: true   },
  { name: 'DOGE2',    chain: 'BSC',      addr: '0x88c7...bDD52',  price: '$0.0034',     change: '+124.5%',vol: '$18.2M', liq: '$8.9M',  safety: 45, lp: true,   sniper: 'warn' },
  { name: 'WIF',      chain: 'Solana',   addr: '7vfCX...mJh2',   price: '$2.1400',     change: '+3.2%',  vol: '$42M',   liq: '$89M',   safety: 92, lp: true,   sniper: true   },
  { name: 'CHAD',     chain: 'Base',     addr: '0x912C...6548',   price: '$0.000010',   change: '-5.4%',  vol: '$120K', liq: '$340K',  safety: 28, lp: false,  sniper: true   },
  { name: 'POPCAT',   chain: 'Solana',   addr: '7GC1h...Ym2h',   price: '$0.5400',     change: '+19.8%', vol: '$8.1M',  liq: '$22M',   safety: 85, lp: true,   sniper: true   },
  { name: 'TURBO',    chain: 'Ethereum', addr: '0x4Fab...C53',    price: '$0.0092',     change: '+67.2%', vol: '$3.4M',  liq: '$5.6M',  safety: 71, lp: true,   sniper: 'warn' },
  { name: 'MOODENG',  chain: 'BSC',      addr: '0xA3c9...1F2d',   price: '$0.0021',     change: '+88.4%', vol: '$6.7M',  liq: '$3.2M',  safety: 52, lp: true,   sniper: true   },
  { name: 'GOAT',     chain: 'Solana',   addr: '7Nrtk...9xLe',   price: '$0.3100',     change: '-8.2%',  vol: '$1.9M',  liq: '$6.8M',  safety: 74, lp: true,   sniper: true   },
  { name: 'PNUT',     chain: 'Base',     addr: '0x70c3...6A11',   price: '$0.000780',   change: '+211.3%',vol: '$24.1M', liq: '$11.4M', safety: 41, lp: false,  sniper: 'warn' },
  { name: 'FARTCOIN', chain: 'Solana',   addr: '9NkpL...4nRt',   price: '$0.00002900', change: '-56.7%', vol: '$900K', liq: '$420K',  safety: 22, lp: false,  sniper: false  },
]

const TABS = ['All', 'Solana', 'Ethereum', 'BSC', 'Base', 'Arbitrum', 'Avalanche']

const css = `
  @import url('https://fonts.googleapis.com/css2?family=DM+Mono:wght@400;500&family=DM+Sans:wght@400;500;700;800&display=swap');

  *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }

  html, body, #root {
    width: 100%;
    height: 100%;
    font-family: 'DM Sans', sans-serif;
    background: #000;
  }

  #root {
    display: flex;
    padding: 10px;
  }

  /* ── outer border: subtle blue-grey, matches dark theme ── */
  .outer-border {
    flex: 1;
    border: 1.5px solid rgba(79,142,247,0.25);
    border-radius: 12px;
    padding: 5px;
    display: flex;
    min-height: 0;
    box-shadow: 0 0 0 1px rgba(79,142,247,0.08), 0 0 24px rgba(79,142,247,0.06);
  }

  .app {
    flex: 1;
    background: #0d0f14;
    border-radius: 8px;
    display: flex;
    flex-direction: column;
    overflow: hidden;
    min-height: 0;
  }

  /* ── Navbar ── */
  .navbar {
    display: flex;
    align-items: center;
    justify-content: space-between;
    padding: 12px 20px;
    border-bottom: 1px solid #1e2230;
    flex-shrink: 0;
  }
  .logo { display: flex; align-items: center; gap: 10px; }
  .logo-bird { font-size: 22px; line-height: 1; }
  .logo-text { font-weight: 800; font-size: 18px; letter-spacing: 0.1em; color: #fff; }

  .live-badge {
    display: flex; align-items: center; gap: 5px;
    background: rgba(34,197,94,0.12);
    border: 1px solid rgba(34,197,94,0.35);
    border-radius: 20px; padding: 3px 10px;
    font-size: 11px; font-weight: 700; color: #22c55e; letter-spacing: 0.06em;
  }
  .live-dot {
    width: 7px; height: 7px; background: #22c55e; border-radius: 50%;
    animation: pulse 1.5s infinite;
  }
  @keyframes pulse { 0%,100%{opacity:1} 50%{opacity:0.3} }

  .nav-right { display: flex; align-items: center; gap: 8px; }

  .sol-btn {
    background: #1a1d27; border: 1px solid #2a2d3e;
    color: #a0a8c0; font-family: 'DM Mono', monospace;
    font-size: 12px; padding: 6px 13px; border-radius: 7px;
    cursor: pointer; transition: border-color 0.15s, color 0.15s;
  }
  .sol-btn:hover, .sol-btn.active { border-color: #4f8ef7; color: #4f8ef7; }

  .connect-btn {
    background: linear-gradient(135deg, #4f8ef7, #6c63ff);
    color: #fff; font-size: 13px; font-weight: 700;
    padding: 7px 18px; border-radius: 8px; border: none; cursor: pointer;
    font-family: 'DM Sans', sans-serif; transition: opacity 0.15s;
  }
  .connect-btn:hover { opacity: 0.85; }

  /* ── Tabs ── */
  .tabs {
    display: flex; padding: 0 20px;
    border-bottom: 1px solid #1e2230; flex-shrink: 0;
  }
  .tab {
    font-size: 13px; font-weight: 500; color: #5a6080;
    padding: 10px 14px; cursor: pointer; border: none;
    border-bottom: 2px solid transparent; margin-bottom: -1px;
    background: transparent; font-family: 'DM Sans', sans-serif;
    transition: color 0.15s;
  }
  .tab:hover { color: #a0a8c0; }
  .tab.active { color: #fff; border-bottom-color: #4f8ef7; }

  /* ── Main layout ── */
  .main { display: flex; flex: 1; overflow: hidden; min-height: 0; }

  /* ── Token section ── */
  .token-section {
    flex: 1; display: flex; flex-direction: column; overflow: hidden;
    border-right: 1px solid #1e2230; min-width: 0;
  }

  .table-header-row {
    display: flex; align-items: center; justify-content: space-between;
    padding: 10px 18px; flex-shrink: 0;
  }
  .token-count { font-size: 12px; color: #5a6080; font-weight: 600; letter-spacing: 0.05em; }
  .live-indicator { display: flex; align-items: center; gap: 5px; font-size: 12px; color: #22c55e; font-weight: 600; }

  /* ── Table ── */
  .table-wrap { flex: 1; overflow-y: auto; overflow-x: auto; }

  /* FIXED: scrollbar track uses dark bg, no white border */
  .table-wrap::-webkit-scrollbar { width: 4px; height: 4px; }
  .table-wrap::-webkit-scrollbar-track { background: #0d0f14; }
  .table-wrap::-webkit-scrollbar-thumb { background: #2a2d3e; border-radius: 4px; }
  .table-wrap::-webkit-scrollbar-thumb:hover { background: #3a4060; }
  .table-wrap { scrollbar-width: thin; scrollbar-color: #2a2d3e #0d0f14; }

  table { width: 100%; border-collapse: collapse; font-size: 13px; }

  thead tr { position: sticky; top: 0; background: #0d0f14; z-index: 10; }

  th {
    text-align: left; padding: 9px 14px; color: #5a6080;
    font-size: 11px; font-weight: 600; letter-spacing: 0.07em;
    text-transform: uppercase; border-bottom: 1px solid #1e2230; white-space: nowrap;
  }
  td { padding: 11px 14px; border-bottom: 1px solid #1a1d27; vertical-align: middle; white-space: nowrap; }
  tbody tr { border: 1px solid transparent; transition: border-color 0.15s; }
  tbody tr:hover { border-color: rgba(79,142,247,0.18); }
  tbody tr:hover td { background: rgba(79,142,247,0.05); }

  .token-name { font-weight: 700; font-size: 15px; color: #fff; line-height: 1; }
  .token-chain { font-size: 11px; color: #5a6080; margin-top: 3px; }
  .address { font-family: 'DM Mono', monospace; font-size: 11px; color: #4a5070; }
  .price { font-family: 'DM Mono', monospace; font-size: 13px; color: #c8d0e8; font-weight: 500; }
  .pos { color: #22c55e; font-weight: 700; font-size: 13px; }
  .neg { color: #ef4444; font-weight: 700; font-size: 13px; }
  .muted { font-family: 'DM Mono', monospace; font-size: 12px; color: #8090b0; }

  .safety-badge {
    display: inline-flex; align-items: center; justify-content: center;
    width: 32px; height: 22px; border-radius: 5px;
    font-size: 11px; font-weight: 700; font-family: 'DM Mono', monospace;
  }
  .s-high { background: rgba(34,197,94,0.15); color: #22c55e; }
  .s-mid  { background: rgba(234,179,8,0.15); color: #eab308; }
  .s-low  { background: rgba(239,68,68,0.15); color: #ef4444; }

  .i-check { color: #22c55e; font-size: 16px; }
  .i-x     { color: #ef4444; font-size: 16px; }
  .i-warn  { color: #eab308; font-size: 15px; }

  .buy-btn {
    background: linear-gradient(135deg, #4f8ef7, #6c63ff);
    color: #fff; font-size: 12px; font-weight: 700;
    padding: 6px 18px; border-radius: 7px; border: none; cursor: pointer;
    font-family: 'DM Sans', sans-serif; letter-spacing: 0.05em;
    transition: opacity 0.15s, transform 0.1s;
  }
  .buy-btn:hover { opacity: 0.85; transform: scale(1.04); }

  /* ── Chat ── */
  .chat-section {
    width: 280px; flex-shrink: 0; display: flex;
    flex-direction: column; background: #0b0d12;
  }
  .chat-title {
    padding: 12px 16px; font-size: 11px; font-weight: 700;
    letter-spacing: 0.1em; color: #5a6080; text-transform: uppercase;
    border-bottom: 1px solid #1e2230; flex-shrink: 0;
  }

  .chat-messages {
    flex: 1; overflow-y: auto; padding: 14px;
    display: flex; flex-direction: column; gap: 12px;
  }

  /* FIXED: chat scrollbar — dark themed, no white */
  .chat-messages::-webkit-scrollbar { width: 5px; }
  .chat-messages::-webkit-scrollbar-track { background: #0f1119; border-radius: 4px; border: 1px solid #1e2230; }
  .chat-messages::-webkit-scrollbar-thumb { background: #2e3450; border-radius: 4px; }
  .chat-messages::-webkit-scrollbar-thumb:hover { background: #4f8ef7; }
  .chat-messages { scrollbar-width: thin; scrollbar-color: #2e3450 #0f1119; }

  .bubble-agent {
    background: #161926; border: 1px solid #1e2230;
    border-radius: 10px 10px 10px 3px; padding: 12px 14px;
    font-size: 13px; line-height: 1.6; color: #a0a8c0;
    align-self: flex-start; max-width: 95%;
  }
  .bubble-user {
    background: rgba(79,142,247,0.15); border: 1px solid rgba(79,142,247,0.25);
    border-radius: 10px 10px 3px 10px; padding: 12px 14px;
    font-size: 13px; line-height: 1.6; color: #c8d0e8;
    align-self: flex-end; max-width: 95%;
  }

  .chat-footer { padding: 12px 14px; border-top: 1px solid #1e2230; flex-shrink: 0; }

  .chat-commands { display: flex; gap: 6px; margin-bottom: 10px; flex-wrap: wrap; }
  .cmd-tag {
    background: #161926; border: 1px solid #2a2d3e;
    border-radius: 6px; padding: 4px 10px; font-size: 11px; color: #6070a0;
    font-family: 'DM Mono', monospace; cursor: pointer;
    transition: border-color 0.15s, color 0.15s;
  }
  .cmd-tag:hover { border-color: #4f8ef7; color: #4f8ef7; }

  .chat-input-row { display: flex; gap: 8px; align-items: center; }
  .chat-input {
    flex: 1; background: #161926; border: 1px solid #2a2d3e;
    border-radius: 8px; padding: 8px 12px; font-size: 12px;
    color: #a0a8c0; font-family: 'DM Sans', sans-serif;
    outline: none; transition: border-color 0.15s;
  }
  .chat-input::placeholder { color: #3a4060; }
  .chat-input:focus { border-color: #4f8ef7; }

  .chat-send {
    width: 34px; height: 34px;
    background: linear-gradient(135deg, #4f8ef7, #6c63ff);
    border: none; border-radius: 8px; cursor: pointer;
    font-size: 15px; color: #fff; flex-shrink: 0;
    transition: opacity 0.15s; display: flex; align-items: center; justify-content: center;
  }
  .chat-send:hover { opacity: 0.85; }
`

function safetyClass(s: number) {
  if (s >= 70) return 's-high'
  if (s >= 40) return 's-mid'
  return 's-low'
}

function StatusIcon({ val }: { val: IconStatus }) {
  if (val === true)    return <span className="i-check">✓</span>
  if (val === false)   return <span className="i-x">✕</span>
  return <span className="i-warn">⚠</span>
}

export default function App() {
  const [activeTab, setActiveTab] = useState('All')
  const [solAmt, setSolAmt] = useState('0.1 SOL')
  const [messages, setMessages] = useState<ChatMessage[]>([
    { role: 'agent', text: "Hey! I'm HAWKEYE, your on-chain trading agent. Say /wallet to get started, or paste a contract address to trade." }
  ])
  const [input, setInput] = useState('')
  const [loading, setLoading] = useState(false)
  const bottomRef = useRef<HTMLDivElement>(null)

  // ── Change this to your deployed URL when going live ──
  http://172.160.227.225:8080/api/chat
  const USER_ID = 'frontend-user'

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth' })
  }, [messages])

  const filtered = activeTab === 'All'
    ? TOKENS
    : TOKENS.filter(t => t.chain === activeTab)

  async function send() {
    const t = input.trim()
    if (!t || loading) return
    setMessages(prev => [...prev, { role: 'user', text: t }])
    setInput('')
    setLoading(true)
    try {
      const res = await fetch(API_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ userId: USER_ID, message: t }),
      })
      const data = await res.json()
      setMessages(prev => [...prev, { role: 'agent', text: data.reply ?? 'No response from agent.' }])
    } catch {
      setMessages(prev => [...prev, { role: 'agent', text: '⚠️ Could not reach the HAWKEYE backend. Make sure the server is running on port 3001.' }])
    } finally {
      setLoading(false)
    }
  }

  return (
    <>
      <style>{css}</style>
      <div className="outer-border">
        <div className="app">

          {/* Navbar */}
          <nav className="navbar">
            <div className="logo">
              <span className="logo-bird">🦅</span>
              <span className="logo-text">HAWKEYE</span>
              <div className="live-badge">
                <div className="live-dot" />
                LIVE
              </div>
            </div>
            <div className="nav-right">
              {['0.1 SOL', '0.5 SOL', '1.0 SOL'].map(a => (
                <button
                  key={a}
                  className={`sol-btn${solAmt === a ? ' active' : ''}`}
                  onClick={() => setSolAmt(a)}
                >
                  {a}
                </button>
              ))}
              <button className="connect-btn">Connect Wallet</button>
            </div>
          </nav>

          {/* Tabs */}
          <div className="tabs">
            {TABS.map(tab => (
              <button
                key={tab}
                className={`tab${activeTab === tab ? ' active' : ''}`}
                onClick={() => setActiveTab(tab)}
              >
                {tab}
              </button>
            ))}
          </div>

          {/* Main */}
          <div className="main">

            {/* Token table */}
            <div className="token-section">
              <div className="table-header-row">
                <span className="token-count">{filtered.length} TOKENS</span>
                <div className="live-indicator">
                  <div className="live-dot" />
                  Live
                </div>
              </div>
              <div className="table-wrap">
                <table>
                  <thead>
                    <tr>
                      <th>Token</th>
                      <th>Address</th>
                      <th>Price</th>
                      <th>24H</th>
                      <th>Volume</th>
                      <th>Liquidity</th>
                      <th>Safety</th>
                      <th>LP</th>
                      <th>Sniper</th>
                      <th>Action</th>
                    </tr>
                  </thead>
                  <tbody>
                    {filtered.map(t => (
                      <tr key={t.name + t.addr}>
                        <td>
                          <div className="token-name">{t.name}</div>
                          <div className="token-chain">{t.chain}</div>
                        </td>
                        <td><span className="address">{t.addr}</span></td>
                        <td><span className="price">{t.price}</span></td>
                        <td><span className={t.change.startsWith('+') ? 'pos' : 'neg'}>{t.change}</span></td>
                        <td><span className="muted">{t.vol}</span></td>
                        <td><span className="muted">{t.liq}</span></td>
                        <td><span className={`safety-badge ${safetyClass(t.safety)}`}>{t.safety}</span></td>
                        <td><StatusIcon val={t.lp} /></td>
                        <td><StatusIcon val={t.sniper} /></td>
                        <td><button className="buy-btn">BUY</button></td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>

            {/* Chat */}
            <div className="chat-section">
              <div className="chat-title">Hawkeye Agent Chat</div>
              <div className="chat-messages">
                {messages.map((m, i) => (
                  <div key={i} className={m.role === 'agent' ? 'bubble-agent' : 'bubble-user'}>
                    {m.text}
                  </div>
                ))}
                <div ref={bottomRef} />
              </div>
              <div className="chat-footer">
                <div className="chat-commands">
                  {['/wallet', '/portfolio', '/help'].map(cmd => (
                    <button key={cmd} className="cmd-tag" onClick={() => setInput(cmd)}>
                      {cmd}
                    </button>
                  ))}
                </div>
                <div className="chat-input-row">
                  <input
                    className="chat-input"
                    placeholder={loading ? 'Agent is thinking...' : 'Paste address or command...'}
                    value={input}
                    disabled={loading}
                    onChange={e => setInput(e.target.value)}
                    onKeyDown={e => e.key === 'Enter' && send()}
                  />
                  <button className="chat-send" onClick={send} disabled={loading}>
                    {loading ? '⏳' : '↑'}
                  </button>
                </div>
              </div>
            </div>

          </div>
        </div>
      </div>
    </>
  )
}
