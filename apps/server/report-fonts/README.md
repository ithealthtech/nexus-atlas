# Report PDF fonts

Atlas embeds Noto Sans Regular and Bold in generated reports. Both fonts are distributed under the SIL Open Font License 1.1 in LICENSE.txt.

Upstream files: https://github.com/notofonts/noto-fonts/tree/main/hinted/ttf/NotoSans

The Docker runtime and Windows server package must include this directory beside dist. The renderer resolves fonts relative to its module, so exports do not depend on fonts installed on the host.
