"""Clock refusal messages generated from the board's three string tables."""
import json
import os
import re

with open(os.path.join(os.path.dirname(__file__), "strings.json"), encoding="utf-8") as source:
    CLOCK_STRINGS = json.load(source)


def language_of(env):
    value = (env.get("LC_ALL") or env.get("LC_MESSAGES") or env.get("LANG") or "").strip().lower()
    if re.search(r"zh[-_]?(tw|hk|mo|hant)", value):
        return "zh-TW"
    if re.search(r"zh[-_]?(cn|sg|hans)|^zh\b", value):
        return "zh-CN"
    return "en"


def clock_message(key, lang):
    return CLOCK_STRINGS.get(lang, CLOCK_STRINGS["en"])[key]
