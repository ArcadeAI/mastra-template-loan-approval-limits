// Bun imports a `.sql` file as its text when asked with `{ type: "text" }`.
declare module "*.sql" {
  const text: string;
  export default text;
}
