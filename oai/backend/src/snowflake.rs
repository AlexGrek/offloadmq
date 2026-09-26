//! Twitter-style 63-bit snowflake IDs: 41-bit ms timestamp | 10-bit machine | 12-bit seq.
//! Safe for concurrent use via internal Mutex.

use std::sync::Mutex;
use std::time::{SystemTime, UNIX_EPOCH};

// 2024-01-01T00:00:00Z in milliseconds — keeps IDs small for years to come.
const EPOCH_MS: u64 = 1_704_067_200_000;
const SEQ_MASK: u64 = 0xFFF;

pub struct SnowflakeGenerator {
    machine_id: u64,
    state: Mutex<State>,
}

struct State {
    last_ms: u64,
    seq: u64,
}

impl SnowflakeGenerator {
    pub fn new(machine_id: u16) -> Self {
        assert!(machine_id < 1024, "machine_id must fit in 10 bits");
        SnowflakeGenerator {
            machine_id: machine_id as u64,
            state: Mutex::new(State { last_ms: 0, seq: 0 }),
        }
    }

    pub fn next_id(&self) -> i64 {
        self.next_id_at(now_ms())
    }

    /// The generator's clock is *logical*: it follows wall time but never moves back.
    /// If the system clock steps backwards (NTP correction, VM resume) we keep issuing
    /// from the last timestamp we saw, so IDs stay unique and strictly increasing
    /// instead of re-issuing values from the past. Likewise, when a millisecond's 4096
    /// sequence numbers are used up we borrow the next millisecond rather than
    /// spinning until the wall clock gets there.
    fn next_id_at(&self, wall_ms: u64) -> i64 {
        // A poisoned lock only means another thread panicked mid-call; the state is two
        // plain integers and still consistent, so keep going.
        let mut s = self.state.lock().unwrap_or_else(|e| e.into_inner());
        let mut ms = wall_ms.max(s.last_ms);
        if ms == s.last_ms {
            s.seq = (s.seq + 1) & SEQ_MASK;
            if s.seq == 0 {
                ms += 1;
            }
        } else {
            s.seq = 0;
        }
        s.last_ms = ms;
        let id = (ms.saturating_sub(EPOCH_MS) << 22) | (self.machine_id << 12) | s.seq;
        id as i64
    }
}

fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        // A clock before 1970 is nonsense; 0 is safe because `next_id_at` clamps to the
        // last timestamp it has seen.
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::HashSet;
    use std::sync::Arc;

    const T0: u64 = EPOCH_MS + 1_000_000;

    #[test]
    fn ids_increase_within_and_across_milliseconds() {
        let g = SnowflakeGenerator::new(1);
        let a = g.next_id_at(T0);
        let b = g.next_id_at(T0);
        let c = g.next_id_at(T0 + 1);
        assert!(a < b && b < c);
    }

    #[test]
    fn clock_stepping_backwards_never_reissues_or_decreases() {
        let g = SnowflakeGenerator::new(1);
        let mut prev = g.next_id_at(T0 + 500);
        // Wall clock jumps back 400 ms, then wobbles around.
        for wall in [T0 + 100, T0 + 100, T0 + 499, T0 + 500, T0 + 501] {
            let id = g.next_id_at(wall);
            assert!(id > prev, "id {id} did not exceed {prev} at wall={wall}");
            prev = id;
        }
    }

    #[test]
    fn sequence_exhaustion_borrows_the_next_millisecond() {
        let g = SnowflakeGenerator::new(1);
        // Far more than 4096 ids in one wall-clock millisecond.
        let ids: Vec<i64> = (0..10_000).map(|_| g.next_id_at(T0)).collect();
        assert!(
            ids.windows(2).all(|w| w[0] < w[1]),
            "ids must be strictly increasing"
        );
        let unique: HashSet<_> = ids.iter().collect();
        assert_eq!(unique.len(), ids.len());
    }

    #[test]
    fn encodes_timestamp_machine_and_sequence() {
        let g = SnowflakeGenerator::new(37);
        let id = g.next_id_at(T0) as u64;
        assert_eq!(id >> 22, T0 - EPOCH_MS);
        assert_eq!((id >> 12) & 0x3FF, 37);
        assert_eq!(id & SEQ_MASK, 0);
    }

    #[test]
    fn concurrent_callers_get_unique_ids() {
        let g = Arc::new(SnowflakeGenerator::new(1));
        let handles: Vec<_> = (0..8)
            .map(|_| {
                let g = g.clone();
                std::thread::spawn(move || (0..5_000).map(|_| g.next_id()).collect::<Vec<_>>())
            })
            .collect();
        let mut all = HashSet::new();
        let mut total = 0;
        for h in handles {
            for id in h.join().unwrap() {
                total += 1;
                all.insert(id);
            }
        }
        assert_eq!(
            all.len(),
            total,
            "duplicate snowflake ids under concurrency"
        );
    }

    #[test]
    fn a_wall_clock_before_the_epoch_does_not_panic() {
        let g = SnowflakeGenerator::new(1);
        let _ = g.next_id_at(0);
        let _ = g.next_id_at(5);
    }
}
