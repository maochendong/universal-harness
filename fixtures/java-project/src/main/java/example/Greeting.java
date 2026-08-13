package example;

/** Sample source content for the Java fixture; scanned, not compiled, in E2E. */
public final class Greeting {
  private Greeting() {}

  /** Return a deterministic salutation. */
  public static String greeting(String name) {
    return "hello, " + name;
  }
}
