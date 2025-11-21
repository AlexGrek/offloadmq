use std::sync::RwLock;

#[derive(Debug, Clone)]
pub struct Config {
    pub shuffle_queue: bool,
    pub allow_assigning_to_same_top_tier: bool,
}

impl Default for Config {
    fn default() -> Self {
        Self {
            shuffle_queue: false,
            allow_assigning_to_same_top_tier: false,
        }
    }
}

// Global configuration using RwLock
static CONFIG: RwLock<Config> = RwLock::new(Config {
    shuffle_queue: false,
    allow_assigning_to_same_top_tier: false,
});

// Initialize configuration (call once at startup)
pub fn init_config(shuffle_queue: bool, allow_assigning_to_same_top_tier: bool) {
    let mut config = CONFIG.write().unwrap();
    config.shuffle_queue = shuffle_queue;
    config.allow_assigning_to_same_top_tier = allow_assigning_to_same_top_tier;
}

// Get a copy of the current configuration
pub fn get_config() -> Config {
    CONFIG.read().unwrap().clone()
}

// Convenience functions to access individual fields
pub fn shuffle_queue() -> bool {
    CONFIG.read().unwrap().shuffle_queue
}

pub fn allow_assigning_to_same_top_tier() -> bool {
    CONFIG.read().unwrap().allow_assigning_to_same_top_tier
}
