"""
agent/server.py
FastAPI service exposing AI routing decisions to the Node.js orchestrator.
"""

import os
from typing import Any, Dict, Optional

from dotenv import load_dotenv
from fastapi import FastAPI, HTTPException
from pydantic import BaseModel, Field

import os
import sys

sys.path.insert(0, os.path.dirname(__file__))

import agent as routing_agent

load_dotenv()

app = FastAPI(title="Payment Routing Agent", version="1.0.0")


class RoutingRequest(BaseModel):
    merchant_id: str
    amount: float
    currency: str = "INR"
    card_brand: str = "UNKNOWN"
    country: str = "IN"
    decline_code: Optional[str] = "NONE"


class RoutingResponse(BaseModel):
    selected_acquirer: str
    confidence_score: float
    reasoning: str
    recovery_strategy: Optional[str] = None
    retry_delay_seconds: int = 300


@app.get("/health")
def health():
    return {"status": "UP", "service": "payment-routing-agent"}


@app.post("/route", response_model=RoutingResponse)
def route_payment(request: RoutingRequest):
    try:
        decision = routing_agent.evaluate_routing_strategy(request.model_dump())
        return RoutingResponse(**decision)
    except Exception as exc:
        raise HTTPException(status_code=500, detail=str(exc)) from exc


if __name__ == "__main__":
    import uvicorn

    port = int(os.getenv("AGENT_PORT", "8000"))
    uvicorn.run("server:app", host="0.0.0.0", port=port, reload=False)
