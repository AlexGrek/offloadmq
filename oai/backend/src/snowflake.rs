//! Twitter-style 63-bit snowflake IDs: 41-bit ms timestamp | 10-bit machine | 12-bit seq.
//! Safe for concurrent use via internal Mutex.

use std::sync::Mutex;
use std::time::{SystemTime, UNIX_EPOCH};

// 2024-01-01T00:00:00Z in milliseconds — keeps IDs small for years to come.
const EPOCH_MS: u64 = 1_704_067_200_000;

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
        let mut s = self.state.lock().unwrap();
        let mut ms = now_ms();
        if ms == s.last_ms {
            s.seq = (s.seq + 1) & 0xFFF;
            if s.seq == 0 {
                // Sequence exhausted — spin until next millisecond.
                while ms <= s.last_ms {
                    ms = now_ms();
                }
            }
        } else {
            s.seq = 0;
        }
        s.last_ms = ms;
        let id = ((ms - EPOCH_MS) << 22) | (self.machine_id << 12) | s.seq;
        id as i64
    }
}

fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .expect("system clock before UNIX epoch")
        .as_millis() as u64
}
