"""Agent Payment Protocol (bonus): the flight agent sells a simulation flight, the dispatcher buys it.

Per uagents_core.contrib.protocols.payment the seller sends RequestPayment and handles CommitPayment /
RejectPayment; the buyer handles RequestPayment, CompletePayment and CancelPayment. Off unless DRONEX_PAYMENTS=1.
With DRONEX_PAYMENTS_LEDGER=1 the dispatcher really sends testnet FET from its wallet (needs funds from the
faucet); otherwise the commit carries a reference instead of a transaction hash and says so.
"""

from __future__ import annotations

import asyncio
from typing import Awaitable, Callable

from uagents import Context, Protocol
from cosmpy.aerial.client import LedgerClient, NetworkConfig
from cosmpy.aerial.wallet import LocalWallet
from uagents_core.contrib.protocols.payment import (
    CancelPayment,
    CommitPayment,
    CompletePayment,
    Funds,
    RejectPayment,
    RequestPayment,
    payment_protocol_spec,
)

CURRENCY = "atestfet"
PAYMENT_METHOD = "fetch-ledger"
TESTNET_REST = "rest+https://rest-dorado.fetch.ai"


def testnet_ledger() -> LedgerClient:
    """Dorado (Fetch testnet) over REST. The default config speaks gRPC, which some networks block; REST works
    wherever HTTPS does."""
    base = NetworkConfig.fetchai_stable_testnet()
    return LedgerClient(
        NetworkConfig(
            chain_id=base.chain_id,
            url=TESTNET_REST,
            fee_minimum_gas_price=base.fee_minimum_gas_price,
            fee_denomination=base.fee_denomination,
            staking_denomination=base.staking_denomination,
            faucet_url=base.faucet_url,
        )
    )


def paid_on_ledger(ledger: LedgerClient, tx_hash: str, recipient: str, amount: int, denom: str = CURRENCY) -> str | None:
    """None when the transaction moved at least `amount` `denom` to `recipient`; otherwise why not."""
    try:
        tx = ledger.query_tx(tx_hash)
    except Exception as e:
        return f"transaction {tx_hash[:12]}… not found on the testnet ({e.__class__.__name__})"
    if tx.code != 0:
        return f"transaction {tx_hash[:12]}… failed on chain (code {tx.code})"
    # Dorado flattens events by type, later ones winning: the fee transfer comes first, the message's own (msg_index
    # 0, a single MsgSend) last, so "transfer" is the payment.
    transfer = tx.events.get("transfer", {})
    paid = 0
    amt = str(transfer.get("amount", ""))
    if transfer.get("recipient") == recipient and amt.endswith(denom) and amt[: -len(denom)].isdigit():
        paid = int(amt[: -len(denom)])
    return None if paid >= amount else f"transaction {tx_hash[:12]}… paid {paid} {denom} to {transfer.get('recipient', '?')}, expected {amount} to {recipient}"


def fet_to_atestfet(fet: str) -> int:
    whole, _, frac = fet.partition(".")
    frac = (frac + "0" * 18)[:18]
    return int(whole or "0") * 10**18 + int(frac)


def seller_protocol(
    on_committed: Callable[[Context, str, CommitPayment], Awaitable[None]],
    recipient: str,
    verify_ledger: bool = False,
    on_unpaid: Callable[[Context, CommitPayment, str], Awaitable[None]] | None = None,
) -> Protocol:
    """The flight agent's side. `on_committed(ctx, buyer, commit)` runs the flight the commit pays for. With
    `verify_ledger`, a commit that names a transaction is checked on the testnet first (to `recipient`, the amount
    committed); a bad one is cancelled instead of flown."""
    proto = Protocol(spec=payment_protocol_spec, role="seller")

    @proto.on_message(CommitPayment)
    async def _commit(ctx: Context, sender: str, msg: CommitPayment) -> None:
        ctx.logger.info(f"payment committed by {sender[:12]}… ref={msg.reference} tx={msg.transaction_id}")
        if verify_ledger and msg.transaction_id:
            why = await asyncio.to_thread(paid_on_ledger, testnet_ledger(), msg.transaction_id, recipient, int(msg.funds.amount), msg.funds.currency)
            if why:
                ctx.logger.warning(f"payment not verified: {why}")
                await ctx.send(sender, CancelPayment(transaction_id=msg.transaction_id, reason=why))
                if on_unpaid:
                    await on_unpaid(ctx, msg, why)
                return
            ctx.logger.info(f"payment verified on the testnet: {msg.transaction_id}")
        await ctx.send(sender, CompletePayment(transaction_id=msg.transaction_id or msg.reference or "none"))
        await on_committed(ctx, sender, msg)  # the paid-for work runs after the receipt, it can take minutes

    @proto.on_message(RejectPayment)
    async def _reject(ctx: Context, sender: str, msg: RejectPayment) -> None:
        ctx.logger.info(f"payment rejected by {sender[:12]}…: {msg.reason}")

    return proto


async def request_payment(ctx: Context, buyer: str, *, recipient: str, reference: str, price_fet: str, description: str) -> None:
    """`recipient` is the seller's wallet address (agent.wallet.address(); the handler's ctx.agent has no wallet)."""
    await ctx.send(
        buyer,
        RequestPayment(
            accepted_funds=[Funds(amount=str(fet_to_atestfet(price_fet)), currency=CURRENCY, payment_method=PAYMENT_METHOD)],
            recipient=recipient,
            deadline_seconds=120,
            reference=reference,
            description=description,
        ),
    )


def _send(recipient: str, amount: int, denom: str, wallet: LocalWallet, memo: str) -> str:
    """A testnet transfer, waited for; returns the transaction hash. Blocking: call it in a thread."""
    submitted = testnet_ledger().send_tokens(recipient, amount, denom, wallet, memo=memo)
    submitted.wait_to_complete()
    return submitted.tx_hash


def buyer_protocol(ledger: bool, wallet: LocalWallet | None = None, on_settled: Callable[[Context, str, str], Awaitable[None]] | None = None) -> Protocol:
    """The dispatcher's side: commits every request (on the testnet ledger from `wallet` when `ledger`), logs
    completion."""
    proto = Protocol(spec=payment_protocol_spec, role="buyer")

    @proto.on_message(RequestPayment)
    async def _request(ctx: Context, sender: str, msg: RequestPayment) -> None:
        funds = msg.accepted_funds[0] if msg.accepted_funds else Funds(amount="0", currency=CURRENCY, payment_method=PAYMENT_METHOD)
        tx = ""
        if ledger and wallet is not None:
            try:
                tx = await asyncio.to_thread(_send, msg.recipient, int(funds.amount), funds.currency, wallet, msg.reference or "")
                ctx.logger.info(f"paid {funds.amount} {funds.currency} on the testnet: {tx}")
            except Exception as e:  # no funds, no ledger: say so and commit by reference
                ctx.logger.warning(f"ledger transfer failed ({e}); committing by reference")
        await ctx.send(sender, CommitPayment(funds=funds, recipient=msg.recipient, transaction_id=tx, reference=msg.reference, description=msg.description, metadata={"mode": "ledger" if tx else "reference"}))

    @proto.on_message(CompletePayment)
    async def _complete(ctx: Context, sender: str, msg: CompletePayment) -> None:
        ctx.logger.info(f"payment complete ({msg.transaction_id})")
        if on_settled:
            await on_settled(ctx, sender, msg.transaction_id)

    @proto.on_message(CancelPayment)
    async def _cancel(ctx: Context, sender: str, msg: CancelPayment) -> None:
        ctx.logger.info(f"payment cancelled: {msg.reason}")

    return proto
