"""Browser regressions against a separately started, local TennisMoon app.

Requires Python, system Chromium on PATH, and:
    python3 -m pip install -r tests/requirements.txt

With the built application running locally on port 3000, run from the repo root:
    TENNISMOON_BASE_URL=http://127.0.0.1:3000 PYTHONDONTWRITEBYTECODE=1 \\
        python3 -m unittest discover -s tests -p test_goals_reliability.py -v

The reload test deliberately asserts the dashboard's persistence promise. It
fails on the original implementation; do not disable it for integration.
"""

import ipaddress
import os
import shutil
import unittest
from urllib.parse import urlsplit

from playwright.sync_api import expect, sync_playwright


def is_loopback_url(value):
    try:
        parsed = urlsplit(value)
        host = parsed.hostname
        parsed.port  # Reject invalid port numbers before making a request.
        if parsed.scheme not in {"http", "https"} or not host:
            return False
        if parsed.username is not None or parsed.password is not None:
            return False
        return host.lower() == "localhost" or ipaddress.ip_address(host).is_loopback
    except ValueError:
        return False


def route_loopback_requests(route):
    if not is_loopback_url(route.request.url):
        route.abort("blockedbyclient")
        return
    # Never forward redirects: Chromium can follow them without routing again.
    response = route.fetch(max_redirects=0)
    if 300 <= response.status < 400:
        route.abort("blockedbyclient")
    else:
        route.fulfill(response=response)


class GoalsReliabilityTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.base_url = os.environ.get(
            "TENNISMOON_BASE_URL", "http://127.0.0.1:5173"
        ).rstrip("/") + "/"
        if not is_loopback_url(cls.base_url):
            raise ValueError("TENNISMOON_BASE_URL must be an HTTP(S) loopback URL")
        parsed = urlsplit(cls.base_url)
        if parsed.query or parsed.fragment:
            raise ValueError("TENNISMOON_BASE_URL must not contain a query or fragment")
        executable = shutil.which("chromium") or shutil.which("chromium-browser")
        if executable is None:
            raise RuntimeError("System Chromium is required for these browser tests")
        cls.playwright = sync_playwright().start()
        cls.addClassCleanup(cls.playwright.stop)
        cls.browser = cls.playwright.chromium.launch(
            executable_path=executable,
            headless=True,
            args=["--no-sandbox"],
        )
        cls.addClassCleanup(cls.browser.close)

    def setUp(self):
        self.context = self.browser.new_context(service_workers="block")
        self.addCleanup(self.context.close)

        self.context.route("**/*", route_loopback_requests)
        self.page = self.context.new_page()
        self.page.set_default_timeout(5000)
        response = self.page.goto(self.base_url, wait_until="domcontentloaded")
        self.assertIsNotNone(response, "The local app did not return an HTTP response")
        self.assertEqual(response.status, 200, "The local app must return HTTP 200")
        expect(self.page.get_by_role("button", name="Player Radar", exact=True)).to_be_visible()
        expect(self.page.get_by_role("heading", name="Carlos Alcaraz", exact=True)).to_be_visible()

    def open_goals(self):
        self.page.get_by_role("button", name="My Moonshot", exact=True).click()
        expect(self.page.get_by_role("heading", name="GOALS IN MOTION", exact=True)).to_be_visible()
        return self.page.locator(".goal-card").filter(
            has=self.page.get_by_role(
                "heading", name="Build a reliable second serve", exact=True
            )
        )

    def assert_progress(self, expected):
        expect(self.page.locator(".goal-card .progress-row strong")).to_have_text(
            [f"{value}%" for value in expected]
        )

    def test_player_radar_search_and_tour_filters(self):
        cards = self.page.get_by_role("article")
        search = self.page.get_by_role("textbox", name="Search players and events")
        tours = self.page.get_by_role("group", name="Tour filter")
        expect(cards).to_have_count(4)

        tours.get_by_role("button", name="ATP", exact=True).click()
        expect(cards.get_by_role("heading", level=3)).to_have_text(
            ["Carlos Alcaraz", "Jannik Sinner"]
        )
        search.fill("poland")
        expect(cards).to_have_count(0)
        tours.get_by_role("button", name="WTA", exact=True).click()
        expect(cards.get_by_role("heading", level=3)).to_have_text(["Iga Świątek"])

        search.fill("US OPEN")
        expect(cards.get_by_role("heading", level=3)).to_have_text(
            ["Coco Gauff", "Iga Świątek"]
        )
        search.fill("no matching player or event")
        expect(cards).to_have_count(0)
        search.fill("")
        tours.get_by_role("button", name="ALL", exact=True).click()
        expect(cards).to_have_count(4)

    def test_each_click_adds_five_and_tab_switching_preserves_progress(self):
        goal = self.open_goals()
        self.assert_progress([72, 67, 45])
        goal.get_by_role("button", name="Log progress +5%", exact=True).click()
        self.assert_progress([77, 67, 45])

        for _ in range(3):
            self.page.get_by_role("button", name="Player Radar", exact=True).click()
            expect(self.page.get_by_role("heading", name="Carlos Alcaraz", exact=True)).to_be_visible()
            goal = self.open_goals()
            self.assert_progress([77, 67, 45])

        goal.get_by_role("button", name="Log progress +5%", exact=True).click()
        self.assert_progress([82, 67, 45])

    def test_rapid_clicks_accumulate_and_progress_caps_at_one_hundred(self):
        goal = self.open_goals()
        self.assert_progress([72, 67, 45])
        button = goal.get_by_role("button", name="Log progress +5%", exact=True)
        button.click(click_count=3, delay=0)
        self.assert_progress([87, 67, 45])
        button.click(click_count=6, delay=0)
        self.assert_progress([100, 67, 45])
        self.assertEqual(
            goal.locator(".progress-track > span").evaluate("element => element.style.width"),
            "100%",
        )
        button.click(click_count=3, delay=0)
        self.assert_progress([100, 67, 45])

    def test_progress_survives_reload_as_the_dashboard_promises(self):
        goal = self.open_goals()
        self.assert_progress([72, 67, 45])
        expect(self.page.get_by_text("Progress is saved across sessions.", exact=False)).to_be_visible()
        goal.get_by_role("button", name="Log progress +5%", exact=True).click()
        self.assert_progress([77, 67, 45])

        self.page.reload(wait_until="domcontentloaded")
        self.open_goals()
        self.assert_progress([77, 67, 45])


if __name__ == "__main__":
    unittest.main(verbosity=2)
