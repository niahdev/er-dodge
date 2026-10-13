import importlib.util
import unittest
from pathlib import Path


SCRIPT_PATH = Path(__file__).parents[1] / "scripts" / "collect_patch_notes.py"
SPEC = importlib.util.spec_from_file_location("collect_patch_notes", SCRIPT_PATH)
MODULE = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(MODULE)


class ParseCharactersTest(unittest.TestCase):
    def test_new_character_is_not_merged_into_previous_character(self):
        html = """<div class="er-article-detail__content">
        <p><strong>코렐라인</strong></p>
        <p>코렐라인 설명</p>
        <ul><li><p>기본 공격 피해량 10 → 11</p></li></ul>
        <p><strong>크레이버</strong></p>
        <p>크레이버 설명</p>
        <ul><li><p>스킬 피해량 20 → 21</p></li></ul>
        </div>"""

        parsed = MODULE.parse_characters(html, ["코렐라인", "크레이버"])

        self.assertEqual([entry["character"] for entry in parsed], ["코렐라인", "크레이버"])
        self.assertEqual(parsed[0]["comment"], "코렐라인 설명")
        self.assertEqual(parsed[1]["comment"], "크레이버 설명")

    def test_unknown_bold_character_ends_previous_section(self):
        html = """<div class="er-article-detail__content">
        <p><strong>코렐라인</strong></p>
        <p>코렐라인 설명</p>
        <ul><li><p>기본 공격 피해량 10 → 11</p></li></ul>
        <p><strong>미등록신규캐릭터</strong></p>
        <p>새 캐릭터 설명</p>
        <ul><li><p>스킬 피해량 20 → 21</p></li></ul>
        </div>"""

        parsed = MODULE.parse_characters(html, ["코렐라인"])

        self.assertEqual(len(parsed), 1)
        self.assertEqual(parsed[0]["character"], "코렐라인")
        self.assertEqual(len(parsed[0]["changes"]), 1)


if __name__ == "__main__":
    unittest.main()
