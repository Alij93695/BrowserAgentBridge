# BrowserAgentBridge Daemon
import asyncio
import json
import logging
import uuid
import os
from typing import Dict, Set
from fastapi import FastAPI, WebSocket, WebSocketDisconnect, HTTPException, Request
from fastapi.responses import HTMLResponse, JSONResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel

# Configure logging
log_formatter = logging.Formatter("%(asctime)s [%(levelname)s] %(message)s")

# File handler for webbridge.log
file_handler = logging.FileHandler("webbridge.log", encoding="utf-8")
file_handler.setFormatter(log_formatter)
file_handler.setLevel(logging.INFO)

# Console handler
console_handler = logging.StreamHandler()
console_handler.setFormatter(log_formatter)
console_handler.setLevel(logging.INFO)

logger = logging.getLogger("browseragentbridge-daemon")
logger.setLevel(logging.INFO)
logger.addHandler(file_handler)
logger.addHandler(console_handler)

app = FastAPI(title="BrowserAgentBridge Daemon")

# In-memory storage for active connections and pending command requests
class ExtensionManager:
    def __init__(self):
        self.active_websocket: WebSocket = None
        self.pending_requests: Dict[str, asyncio.Future] = {}
        self.last_status = "disconnected"
        self.last_tab_list = []
        self.last_screenshot = None

    def set_websocket(self, websocket: WebSocket):
        self.active_websocket = websocket
        self.last_status = "connected"
        logger.info("Extension WebSocket registered.")

    def remove_websocket(self):
        self.active_websocket = None
        self.last_status = "disconnected"
        logger.info("Extension WebSocket unregistered.")

    def is_connected(self) -> bool:
        return self.active_websocket is not None

    async def send_command(self, action: str, params: dict = {}, timeout: float = 20.0) -> dict:
        if not self.is_connected():
            raise HTTPException(status_code=503, detail="Chrome extension is not connected")

        request_id = str(uuid.uuid4())
        future = asyncio.get_running_loop().create_future()
        self.pending_requests[request_id] = future

        payload = {
            "id": request_id,
            "action": action,
            "params": params
        }

        # Send command to extension
        try:
            await self.active_websocket.send_text(json.dumps(payload))
            log_event(f"Sent command to extension: {action} (ID: {request_id[:8]})")
        except Exception as e:
            self.pending_requests.pop(request_id, None)
            raise HTTPException(status_code=500, detail=f"Failed to communicate with extension: {str(e)}")

        # Wait for response with timeout
        try:
            result = await asyncio.wait_for(future, timeout=timeout)
            return result
        except asyncio.TimeoutError:
            self.pending_requests.pop(request_id, None)
            raise HTTPException(status_code=504, detail=f"Extension timed out after {timeout} seconds")

    def handle_response(self, response_id: str, success: bool, result: dict = None, error: str = None):
        future = self.pending_requests.pop(response_id, None)
        if future and not future.done():
            if success:
                future.set_result(result)
            else:
                future.set_exception(Exception(error or "Unknown extension error"))


extension_manager = ExtensionManager()
dashboard_websockets: Set[WebSocket] = set()
logs_history = []

def log_event(message: str):
    logger.info(message)
    log_item = {"timestamp": os.popen("date /t").read().strip() + " " + os.popen("time /t").read().strip(), "message": message}
    # Wait, simple datetime formatting is cleaner and cross-platform
    from datetime import datetime
    time_str = datetime.now().strftime("%H:%M:%S")
    log_item = {"timestamp": time_str, "message": message}
    logs_history.append(log_item)
    if len(logs_history) > 100:
        logs_history.pop(0)
    
    # Broadcast to all dashboards
    asyncio.create_task(broadcast_to_dashboards({
        "type": "log",
        "log": log_item
    }))

async def broadcast_to_dashboards(data: dict):
    if not dashboard_websockets:
        return
    message = json.dumps(data)
    dead_connections = set()
    for ws in dashboard_websockets:
        try:
            await ws.send_text(message)
        except Exception:
            dead_connections.add(ws)
    for ws in dead_connections:
        dashboard_websockets.discard(ws)

# Command Pydantic Model
class CommandRequest(BaseModel):
    action: str
    params: dict = {}
    timeout: float = 20.0

@app.get("/api/status")
async def get_status():
    return {
        "connected": extension_manager.is_connected(),
        "tabs_count": len(extension_manager.last_tab_list),
        "last_screenshot_available": extension_manager.last_screenshot is not None
    }

@app.get("/api/tabs")
async def get_tabs():
    if not extension_manager.is_connected():
        return {"connected": False, "tabs": []}
    try:
        # Request fresh tab list
        tabs = await extension_manager.send_command("list_tabs", timeout=3.0)
        extension_manager.last_tab_list = tabs
        return {"connected": True, "tabs": tabs}
    except Exception as e:
        return {"connected": True, "tabs": extension_manager.last_tab_list, "error": str(e)}

@app.post("/api/command")
async def post_command(cmd: CommandRequest):
    logger.info(f"Received API command request: {cmd.action}")
    try:
        result = await extension_manager.send_command(cmd.action, cmd.params, cmd.timeout)
        
        # If it was an action that could change page state, schedule a tab list & screenshot refresh
        if cmd.action in ["click", "type", "navigate", "scroll", "select_tab", "new_tab", "close_tab"]:
            # Run screenshot & tab update in background
            schedule_telemetry_refresh()
            
        return {"success": True, "result": result}
    except HTTPException as he:
        raise he
    except Exception as e:
        logger.error(f"Error handling API command: {str(e)}")
        log_event(f"Error in action {cmd.action}: {str(e)}")
        return JSONResponse(status_code=500, content={"success": False, "error": str(e)})

telemetry_task = None

def schedule_telemetry_refresh():
    global telemetry_task
    if telemetry_task and not telemetry_task.done():
        telemetry_task.cancel()
    telemetry_task = asyncio.create_task(refresh_dashboard_telemetry())

async def refresh_dashboard_telemetry():
    # Wait a moment to allow page changes to settle and coalesce events
    try:
        await asyncio.sleep(1.0)
    except asyncio.CancelledError:
        return
        
    if not extension_manager.is_connected():
        return
    try:
        # Fetch fresh tab list
        tabs = await extension_manager.send_command("list_tabs", timeout=3.0)
        extension_manager.last_tab_list = tabs
        await broadcast_to_dashboards({"type": "tabs", "tabs": tabs})
    except Exception as e:
        logger.warning(f"Failed to update tab list telemetry: {str(e)}")

    try:
        # Capture screenshot (optional/silent fallback if tab is in background or minimized)
        screenshot = await extension_manager.send_command("screenshot", timeout=3.0)
        if screenshot and not screenshot.startswith("data:image/png;base64,iVBORw0G"):
            extension_manager.last_screenshot = screenshot
            await broadcast_to_dashboards({"type": "screenshot", "screenshot": screenshot})
    except Exception as e:
        logger.debug(f"Failed to capture background screenshot: {str(e)}")

# WebSocket for the Chrome Extension
@app.websocket("/ws")
async def websocket_endpoint(websocket: WebSocket):
    await websocket.accept()
    extension_manager.set_websocket(websocket)
    log_event("Chrome extension connected.")
    
    # Broadcast connection state to dashboards
    asyncio.create_task(broadcast_to_dashboards({
        "type": "connection",
        "connected": True
    }))
    
    # Trigger initial telemetry load
    schedule_telemetry_refresh()

    try:
        while True:
            data_str = await websocket.receive_text()
            data = json.loads(data_str)
            
            # Check if this is a response to a command
            if "id" in data:
                response_id = data["id"]
                success = data.get("success", False)
                result = data.get("result")
                error = data.get("error")
                logger.info(f"Received response from extension for {response_id[:8]}: success={success}, result={result}, error={error}")
                if not success:
                    logger.error(f"Extension command error: {error}")
                elif isinstance(result, dict) and not result.get("success", True):
                    logger.error(f"Page interaction error: {result.get('error')}")
                extension_manager.handle_response(response_id, success, result, error)
            elif data.get("type") == "status":
                log_event(f"Extension status update: {data.get('status')}")
            
    except WebSocketDisconnect:
        extension_manager.remove_websocket()
        log_event("Chrome extension disconnected.")
        # Broadcast disconnection to dashboards
        asyncio.create_task(broadcast_to_dashboards({
            "type": "connection",
            "connected": False
        }))

# WebSocket for the Web Dashboard
@app.websocket("/dashboard_ws")
async def dashboard_websocket_endpoint(websocket: WebSocket):
    await websocket.accept()
    dashboard_websockets.add(websocket)
    logger.info("Dashboard connected to telemetry.")
    
    # Send current state immediately
    await websocket.send_text(json.dumps({
        "type": "connection",
        "connected": extension_manager.is_connected()
    }))
    
    await websocket.send_text(json.dumps({
        "type": "logs_history",
        "logs": logs_history
    }))
    
    if extension_manager.last_tab_list:
        await websocket.send_text(json.dumps({
            "type": "tabs",
            "tabs": extension_manager.last_tab_list
        }))
        
    if extension_manager.last_screenshot:
        await websocket.send_text(json.dumps({
            "type": "screenshot",
            "screenshot": extension_manager.last_screenshot
        }))
        
    try:
        while True:
            # We just keep it open to stream data, no incoming messages expected for now
            await websocket.receive_text()
    except WebSocketDisconnect:
        dashboard_websockets.discard(websocket)
        logger.info("Dashboard disconnected from telemetry.")


# Serve dashboard files. Make sure the directory exists first.
os.makedirs("dashboard", exist_ok=True)

try:
    app.mount("/", StaticFiles(directory="dashboard", html=True), name="dashboard")
except Exception as e:
    logger.error(f"Failed to mount static files at root: {e}")

if __name__ == "__main__":
    import uvicorn
    logger.info("Starting BrowserAgentBridge Daemon on http://localhost:1313")
    uvicorn.run(app, host="127.0.0.1", port=1313)
