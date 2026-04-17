import { buildIgnorePredicate } from "./src/filter/gitignore.js";
const patterns = ["a/**/b", "**/b", "src/**/*.ts"];
patterns.forEach(p => {
  const pred = buildIgnorePredicate([p]);
  console.log(p);
  pred("dummy"); // dummy call
});
