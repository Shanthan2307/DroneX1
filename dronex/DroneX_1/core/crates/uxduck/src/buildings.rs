//! Native HTTP adapter for the engine's building tiles (DroneX): a POST to
//! the account server's `/v1/buildings`, which fetches OpenStreetMap's and
//! keeps them. Network work never blocks the engine task.

use std::time::Duration;

use uxduck_engine::buildings::{self, BuildingPort};

use crate::daemon::engine_task::EngineHandle;

pub struct Host {
    api: Option<String>,
    engine: EngineHandle,
}

impl Host {
    #[must_use]
    pub fn new(engine: EngineHandle) -> Self {
        Self {
            api: crate::dev_api::api_url(),
            engine,
        }
    }
}

impl BuildingPort for Host {
    fn request(&mut self, x: u32, y: u32) {
        let api = self.api.clone();
        let engine = self.engine.clone();
        tokio::spawn(async move {
            let result = fetch(api.as_deref(), x, y).await;
            let _ = engine.run(move |e| e.buildings_loaded(x, y, result)).await;
        });
    }
}

async fn fetch(api: Option<&str>, x: u32, y: u32) -> Result<Vec<buildings::Building>, String> {
    let api = api.ok_or("no account server")?;
    let client = reqwest::Client::builder()
        // Overpass can take a while for a dense tile the server hasn't kept.
        .timeout(Duration::from_secs(120))
        .redirect(reqwest::redirect::Policy::none())
        .referer(false)
        .build()
        .map_err(|e| e.to_string())?;
    let mut result = client
        .post(format!("{}/v1/buildings", api.trim_end_matches('/')))
        .json(&serde_json::json!({ "x": x, "y": y }))
        .send()
        .await
        .map_err(|e| e.to_string())?;
    if !result.status().is_success() {
        return Err(format!("status {}", result.status()));
    }
    let mut bytes = Vec::new();
    while let Some(chunk) = result.chunk().await.map_err(|e| e.to_string())? {
        if bytes.len() + chunk.len() > buildings::MAX_RESPONSE_BYTES {
            return Err("too large".into());
        }
        bytes.extend_from_slice(&chunk);
    }
    buildings::parse(&bytes)
}
