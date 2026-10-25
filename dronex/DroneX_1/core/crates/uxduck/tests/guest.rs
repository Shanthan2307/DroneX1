//! The public listener (`--public-origin`, DEPLOY item 7): a visitor is a
//! guest at once, may watch and fly, and is refused the host's own methods
//! without a question for the operators.

#![allow(clippy::expect_used, clippy::unwrap_used, reason = "tests")]

use std::path::Path;
use std::process::Stdio;
use std::time::Duration;

use futures::{SinkExt, StreamExt};
use serde_json::{Value, json};
use tokio::process::Command;
use tokio_tungstenite::tungstenite::Message;
use tokio_tungstenite::tungstenite::client::IntoClientRequest;
use tokio_tungstenite::tungstenite::http::HeaderValue;

const BIN: &str = env!("CARGO_BIN_EXE_uxduck");

fn command(directory: &Path) -> Command {
    let mut command = Command::new(BIN);
    command
        .args(["--data-dir"])
        .arg(directory)
        .env("UXDUCK_API_URL", "none")
        .env("UXDUCK_POSTHOG_KEY", "none")
        .env("UXDUCK_TERRAIN_URL", "none")
        .env("UXDUCK_INTERFACE_URL", "none")
        .env("UXDUCK_VIDEO_PORT", "0")
        .env("UXDUCK_TRAY", directory.join("missing-tray"))
        .env_remove("SSH_CONNECTION")
        .env_remove("UXDUCK_NO_TRAY")
        .env_remove("UXDUCK_PUBLIC_ORIGIN")
        .env_remove("UXDUCK_PUBLIC_PORT")
        .kill_on_drop(true);
    command
}

async fn operator_rpc(directory: &Path, method: &str) -> Value {
    let output = command(directory)
        .args(["rpc", "call", method])
        .output()
        .await
        .expect("run CLI");
    assert!(output.status.success(), "{output:?}");
    serde_json::from_slice(&output.stdout).expect("RPC JSON")
}

fn free_port() -> u16 {
    std::net::TcpListener::bind("127.0.0.1:0")
        .unwrap()
        .local_addr()
        .unwrap()
        .port()
}

#[allow(clippy::too_many_lines, reason = "one visit, start to end")]
async fn guest() {
    let directory = tempfile::tempdir().expect("isolated Core data");
    let stderr = directory.path().join("daemon.stderr");
    let port = free_port();
    let origin = format!("http://localhost:{port}");
    let mut daemon = command(directory.path())
        .args(["--exit-on-stdin-close", "daemon", "--port", "0"])
        .args([
            "--public-origin",
            &origin,
            "--public-port",
            &port.to_string(),
        ])
        .stdin(Stdio::piped())
        .stdout(Stdio::null())
        .stderr(std::fs::File::create(&stderr).expect("daemon diagnostics"))
        .spawn()
        .expect("start Core daemon");
    while !directory.path().join("daemon.json").exists() {
        assert!(
            daemon.try_wait().expect("daemon status").is_none(),
            "daemon exited: {}",
            std::fs::read_to_string(&stderr).expect("read daemon diagnostics")
        );
        tokio::time::sleep(Duration::from_millis(50)).await;
    }

    // The page's first look: a guest, no pairing; plain http, no Secure.
    let session = reqwest::Client::new()
        .get(format!("http://127.0.0.1:{port}/api/session"))
        .header("host", format!("localhost:{port}"))
        .send()
        .await
        .expect("ask for a session");
    assert_eq!(session.status(), 200);
    let cookie = session.headers()["set-cookie"].to_str().unwrap().to_owned();
    assert!(!cookie.contains("Secure"), "{cookie}");
    let cookie = cookie.split(';').next().unwrap().to_owned();

    let mut request = format!("ws://127.0.0.1:{port}/rpc")
        .into_client_request()
        .unwrap();
    let headers = request.headers_mut();
    headers.insert(
        "host",
        HeaderValue::from_str(&format!("localhost:{port}")).unwrap(),
    );
    headers.insert("origin", HeaderValue::from_str(&origin).unwrap());
    headers.insert("cookie", HeaderValue::from_str(&cookie).unwrap());
    let (mut socket, _) = tokio_tungstenite::connect_async(request)
        .await
        .expect("open /rpc as a guest");
    let mut ask = async |id: u64, method: &str, params: Value| -> Value {
        let message = json!({ "jsonrpc": "2.0", "id": id, "method": method, "params": params });
        socket
            .send(Message::Text(message.to_string().into()))
            .await
            .unwrap();
        loop {
            let Some(Ok(Message::Text(text))) = socket.next().await else {
                panic!("the guest's socket closed");
            };
            let reply: Value = serde_json::from_str(&text).unwrap();
            if reply["id"] == id {
                return reply;
            }
        }
    };

    let initialized = ask(
        1,
        "initialize",
        json!({
            "clientInfo": { "name": "visitor", "kind": "operator-ui", "version": env!("CARGO_PKG_VERSION") },
            "capabilities": { "protocolVersion": 1 }
        }),
    )
    .await;
    assert_eq!(
        initialized["result"]["granted"],
        json!(["read", "control"]),
        "{initialized}"
    );
    let listed = ask(2, "vehicle/list", json!({})).await;
    assert_eq!(listed["result"]["vehicles"], json!([]), "{listed}");

    let refused = [
        ("storage/reveal", json!({})),
        ("daemon/logs", json!({})),
        (
            "plugin/draft",
            json!({ "id": "x", "name": "x", "script": "" }),
        ),
        (
            "sim/start",
            json!({ "vehicle": "multicopter", "latitudeDeg": 37.0, "longitudeDeg": -122.0 }),
        ),
        ("sim/pause", json!({ "id": "lk-none", "paused": true })),
        ("client/displayList", json!({})),
    ];
    for (id, (method, params)) in (10..).zip(refused) {
        let reply = ask(id, method, params).await;
        assert!(reply.get("result").is_none(), "{method}: {reply}");
        // Capability denied, not held for an operator's answer.
        assert_eq!(reply["error"]["code"], -32003, "{method}: {reply}");
    }
    drop(socket);

    let approvals = operator_rpc(directory.path(), "approval/list").await;
    assert_eq!(approvals["approvals"], json!([]), "{approvals}");
    drop(daemon.stdin.take());
    assert!(daemon.wait().await.expect("clean exit").success());
}

#[tokio::test]
async fn a_guest_of_the_public_listener_flies_but_is_refused_the_host() {
    tokio::time::timeout(Duration::from_secs(30), guest())
        .await
        .expect("the guest test must finish within 30 seconds");
}
