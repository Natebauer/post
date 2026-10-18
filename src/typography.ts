import { Extension, textInputRule } from "@tiptap/react";

/**
 * Typographer's punctuation while writing: curly quotes and apostrophes, an em dash for "--" and
 * an ellipsis for "...". Ctrl+Z right after one gives back the plain characters.
 */
export const Typography = Extension.create({
  name: "postTypography",
  addInputRules() {
    const open = /(?:^|[\s{[(<'"‘“])(")$/;
    const openSingle = /(?:^|[\s{[(<'"‘“])(')$/;
    return [
      textInputRule({ find: /--$/, replace: "—" }),
      textInputRule({ find: /\.\.\.$/, replace: "…" }),
      textInputRule({ find: open, replace: "“" }),
      textInputRule({ find: /"$/, replace: "”" }),
      textInputRule({ find: openSingle, replace: "‘" }),
      textInputRule({ find: /'$/, replace: "’" }),
    ];
  },
});
