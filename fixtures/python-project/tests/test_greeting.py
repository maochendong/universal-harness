"""Stdlib unittest content for the Python fixture.

Run from the repository root with: PYTHONPATH=src python3 -m unittest discover -s tests
"""

import unittest

from greeting import greeting


class GreetingTest(unittest.TestCase):
    def test_greeting(self) -> None:
        self.assertEqual(greeting("world"), "hello, world")


if __name__ == "__main__":
    unittest.main()
