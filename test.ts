import { bus } from './src/shared/event-bus.js';
import { startQuoteAgent } from './src/agents/quote.js';
import { startLightSafetyAgent } from './src/agents/safety-light.js';

startQuoteAgent();
startLightSafetyAgent();

bus.on('QUOTE_RESULT', (quote) => console.log('QUOTE_RESULT', quote));
bus.on('QUOTE_FAILED', (quote) => console.log('QUOTE_FAILED', quote));
bus.on('SAFETY_RESULT', (report) => console.log('SAFETY_RESULT', report));

bus.emit('TRADE_REQUEST', {
  intentId: 'test1',
  userId: '1',
  channel: 'telegram',
  address: '0x990143705c56d601d26856d48C5D85C6BFafe40A',
  chain: 'evm',
  amount: {value: 0, unit: 'NATIVE'},
  exits: [],
  urgency: 'NORMAL',
  rawText: '0x990143705c56d601d26856d48C5D85C6BFafe40A',
  createdAt: Date.now()
});

setTimeout(() => console.log('Done'), 15000);
