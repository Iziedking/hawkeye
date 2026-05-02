# Gensyn AXL — Builder Feedback

Project: HAWKEYE (autonomous trading agent swarm)
Integration: AXL P2P transport replaces in-process EventEmitter for cross-node agent communication.

## How we used it

AxlEventBus bridges typed bus events over the AXL network.
On emit: broadcasts to all connected peers via POST /send.
On recv: polls for inbound events, dispatches to local handlers.
Agents run identically on local or distributed mode.

## What worked

-
-
-

## Pain points

-
-
-

## Bugs encountered

-
-

## Documentation gaps

-
-

## Feature requests

-
-

## SDK feedback

-

## Overall rating (1-10):

---

Last updated:
