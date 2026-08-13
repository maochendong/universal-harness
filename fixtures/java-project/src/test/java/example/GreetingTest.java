package example;

/**
 * Dependency-free test content for the Java fixture: a plain main-method
 * assertion, so running the test never needs a framework download.
 */
public final class GreetingTest {
  private GreetingTest() {}

  public static void main(String[] args) {
    String actual = Greeting.greeting("world");
    if (!"hello, world".equals(actual)) {
      throw new AssertionError("unexpected greeting: " + actual);
    }
    System.out.println("GreetingTest passed");
  }
}
