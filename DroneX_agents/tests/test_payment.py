from types import SimpleNamespace

from dronex_agents.payment import fet_to_atestfet, paid_on_ledger

TO = "fetch1aycuve6wjrhd925yfh6cy638j8lscnktmdrzjx"


class Ledger:
    def __init__(self, code: int = 0, transfer: dict | None = None, missing: bool = False):
        self.code, self.transfer, self.missing = code, transfer or {}, missing

    def query_tx(self, tx_hash: str):
        if self.missing:
            raise RuntimeError("not found")
        return SimpleNamespace(code=self.code, events={"transfer": self.transfer})


def test_fet_to_atestfet():
    assert fet_to_atestfet("0.5") == 5 * 10**17 and fet_to_atestfet("2") == 2 * 10**18 and fet_to_atestfet("0.000000000000000001") == 1


def test_paid_on_ledger_accepts_the_transfer_it_expects():
    ok = Ledger(transfer={"recipient": TO, "amount": f"{5 * 10**17}atestfet", "msg_index": "0"})
    assert paid_on_ledger(ok, "AB" * 32, TO, 5 * 10**17) is None


def test_paid_on_ledger_rejects_short_wrong_failed_or_missing():
    short = Ledger(transfer={"recipient": TO, "amount": "1atestfet"})
    other = Ledger(transfer={"recipient": "fetch1someoneelse", "amount": f"{10**18}atestfet"})
    assert "expected" in paid_on_ledger(short, "AB" * 32, TO, 10)
    assert "expected" in paid_on_ledger(other, "AB" * 32, TO, 10)
    assert "failed on chain" in paid_on_ledger(Ledger(code=5), "AB" * 32, TO, 10)
    assert "not found" in paid_on_ledger(Ledger(missing=True), "AB" * 32, TO, 10)
