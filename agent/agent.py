# Razorpay Agent Studio Integration
# Claude Agent SDK Strategy Module

"""
agent/agent.py
Claude AI Agent Service for Dynamic Gateway Routing & Soft-Decline Analysis
"""

import json
import os
import re
from typing import Any, Dict, Optional

from dotenv import load_dotenv
from pydantic import BaseModel, Field

load_dotenv()

# Initialize Anthropic Claude Client only when API key is present
ANTHROPIC_API_KEY = os.getenv("ANTHROPIC_API_KEY")
anthropic_client = None

if ANTHROPIC_API_KEY and ANTHROPIC_API_KEY != "your_actual_anthropic_api_key_here":
    try:
        from anthropic import Anthropic

        anthropic_client = Anthropic(api_key=ANTHROPIC_API_KEY)
    except Exception as exc:
        print(f"[Agent Warning] Failed to initialize Anthropic client: {exc}")


class RoutingDecision(BaseModel):
    selected_acquirer: str = Field(description="Target acquirer: RAZORPAY, STRIPE, or PAYPAL")
    confidence_score: float = Field(description="Confidence rating from 0.0 to 1.0")
    reasoning: str = Field(description="Detailed rationale for acquirer selection")
    recovery_strategy: Optional[str] = Field(
        default="SMART_RETRY",
        description="Suggested recovery strategy if initial charge soft-declines",
    )
    retry_delay_seconds: int = Field(default=300, description="Recommended backoff delay in seconds")


SYSTEM_PROMPT = """
You are an expert Payment Routing AI Agent for a global payment orchestrator.
Analyze payment transaction context and recommend the optimal primary acquirer gateway
and secondary recovery retry strategy.

Acquirers Available:
1. RAZORPAY: Optimized for INR/Asian currencies, domestic UPI, card transactions.
2. STRIPE: Superior international cross-border coverage, USD/EUR/GBP authorization rates.
3. PAYPAL: High consumer trust for wallet payments and international debit cards.

Rules:
- Output ONLY a valid JSON object with keys: selected_acquirer, confidence_score, reasoning, recovery_strategy, retry_delay_seconds.
- selected_acquirer must be one of: RAZORPAY, STRIPE, PAYPAL.
- Hard declines (STOLEN_CARD, EXPIRED_CARD) should NOT suggest retry strategies.
"""


def _rule_based_fallback(transaction_context: Dict[str, Any], reason: str) -> Dict[str, Any]:
    currency = (transaction_context.get("currency") or "INR").upper()
    selected = "RAZORPAY" if currency == "INR" else "STRIPE"

    return {
        "selected_acquirer": selected,
        "confidence_score": 0.5,
        "reasoning": reason,
        "recovery_strategy": "SMART_RETRY",
        "retry_delay_seconds": 300,
    }


def _parse_json_response(text: str) -> Dict[str, Any]:
    text = text.strip()
    try:
        return json.loads(text)
    except json.JSONDecodeError:
        match = re.search(r"\{.*\}", text, re.DOTALL)
        if match:
            return json.loads(match.group())
        raise


def evaluate_routing_strategy(transaction_context: Dict[str, Any]) -> Dict[str, Any]:
    """Evaluates transaction context using Claude or rule-based fallback."""
    if not anthropic_client:
        return _rule_based_fallback(
            transaction_context,
            "Anthropic API key not configured; using currency-based fallback routing.",
        )

    prompt = f"""
Analyze this transaction context and return your routing decision as JSON:

Merchant ID: {transaction_context.get('merchant_id')}
Amount: {transaction_context.get('amount')}
Currency: {transaction_context.get('currency')}
Card Brand: {transaction_context.get('card_brand', 'UNKNOWN')}
Country: {transaction_context.get('country', 'US')}
Previous Decline Code: {transaction_context.get('decline_code', 'NONE')}
"""

    try:
        response = anthropic_client.messages.create(
            model=os.getenv("ANTHROPIC_MODEL", "claude-sonnet-4-20250514"),
            max_tokens=1000,
            temperature=0.1,
            system=SYSTEM_PROMPT,
            messages=[{"role": "user", "content": prompt}],
        )

        decision_data = _parse_json_response(response.content[0].text)
        validated = RoutingDecision(**decision_data)
        return validated.model_dump()
    except Exception as exc:
        print(f"[Agent Error] Failed to evaluate routing strategy: {exc}")
        return _rule_based_fallback(
            transaction_context,
            f"Fallback rule triggered due to agent error: {exc}",
        )


if __name__ == "__main__":
    sample_tx = {
        "merchant_id": "mer_1001",
        "amount": 149.99,
        "currency": "USD",
        "card_brand": "VISA",
        "country": "US",
        "decline_code": "INSUFFICIENT_FUNDS",
    }

    print("Evaluating strategy for sample transaction...")
    decision = evaluate_routing_strategy(sample_tx)
    print(json.dumps(decision, indent=2))
