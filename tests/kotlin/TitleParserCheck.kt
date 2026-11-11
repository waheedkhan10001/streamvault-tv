// Plain-JVM check of the title cleaner + duplicate merging (no Android needed).
// Run:  kotlinc app/src/main/java/com/streamvault/tv/data/TitleParser.kt tests/kotlin/TitleParserCheck.kt -include-runtime -d /tmp/tp.jar && java -jar /tmp/tp.jar
import com.streamvault.tv.data.TitleParser

var failed = 0
fun check(name: String, ok: Boolean, detail: String = "") {
    println((if (ok) "  PASS  " else "  FAIL  ") + name + (if (!ok && detail.isNotEmpty()) "  -> $detail" else ""))
    if (!ok) failed++
}

fun main() {
    fun p(raw: String, cat: String = "") = TitleParser.parse(raw, cat)

    println("Clean titles")
    p("|EN| [4K-HEVC] Gladiator II (2024) [MULTI-SUB]").let {
        check("pipes+brackets", it.cleanTitle == "Gladiator II" && it.year == 2024 && it.language == "English" && "4K" in it.qualityBadges && "HEVC" in it.qualityBadges && it.subtitleHint == "Multi-Sub", it.toString())
    }
    p("HI - Jawan 2023 FHD Dual Audio").let { check("Hindi prefix", it.cleanTitle == "Jawan" && it.language == "Hindi" && it.year == 2023 && "1080p" in it.qualityBadges, it.toString()) }
    p("AR - The Dark Knight (2008) 1080p").let { check("Arabic prefix", it.cleanTitle == "The Dark Knight" && it.language == "Arabic" && it.year == 2008, it.toString()) }
    p("IT: Chapter Two (2019)").let { check("'IT:' is the movie, not Italian", it.cleanTitle == "IT: Chapter Two" && it.language == "English", it.toString()) }
    p("IT - La Casa (2020)").let { check("'IT -' is Italian", it.language == "Italian" && it.cleanTitle == "La Casa", it.toString()) }
    p("Subway (1985)").let { check("'Subway' is not 'Subtitled'", it.subtitleHint == "", it.toString()) }
    p("Route 265 (2011)").let { check("'265' in a title is not HEVC", "HEVC" !in it.qualityBadges, it.toString()) }
    p("1917 (2019)").let { check("1917 keeps its name, year 2019", it.cleanTitle == "1917" && it.year == 2019, it.toString()) }
    p("2012 (2009)").let { check("2012 keeps its name, year 2009", it.cleanTitle == "2012" && it.year == 2009, it.toString()) }
    p("Blade Runner 2049 (2017)").let { check("Blade Runner 2049", it.cleanTitle == "Blade Runner 2049" && it.year == 2017, it.toString()) }
    p("Mission: Impossible - Fallout (2018)").let { check("colon titles survive", it.cleanTitle.startsWith("Mission: Impossible") && it.year == 2018, it.toString()) }
    p("Dune: Part Two (2024) [4K]").let { check("Dune Part Two", it.cleanTitle == "Dune: Part Two" && it.year == 2024 && "4K" in it.qualityBadges, it.toString()) }
    p("جواب شکوہ (2010)").let { check("Urdu/Arabic script title kept", it.cleanTitle.contains("جواب") && it.dedupKey.startsWith("title:") && it.year == 2010, it.toString()) }
    p("Inception").let { check("no year still works", it.cleanTitle == "Inception" && it.year == 0 && it.dedupKey == "title:inception", it.toString()) }
    p("Inception", "2010 Movies").let { check("year from folder name", it.year == 2010, it.toString()) }
    p("Spider-Man: No Way Home (2021)", "EN | Action Movies").let { check("language + genre from folder", it.language == "English" && "Action" in it.inferredGenres, it.toString()) }

    println("\nDuplicates merge into ONE card (same dedupKey)")
    val copies = listOf(
        "EN - Gladiator (2000) 4K", "|EN| Gladiator (2000) [1080p]", "HI - Gladiator 2000 Dual Audio",
        "GLADIATOR (2000) HEVC", "Gladiator [2000] FHD"
    )
    val keys = copies.map { p(it).dedupKey }.toSet()
    check("5 differently-written copies of Gladiator -> 1 key", keys.size == 1, keys.toString())
    check("Gladiator (2000) and Gladiator II (2024) stay separate", p("Gladiator (2000)").dedupKey != p("Gladiator II (2024)").dedupKey)
    check("same name, different year stay separate (remakes)", p("Dune (1984)").dedupKey != p("Dune (2021)").dedupKey)
    check("tmdb id wins when known", TitleParser.parse("Whatever", "", 155).dedupKey == "tmdb:155")
    check("'The Matrix' vs 'Matrix' stay separate (no guessing)", p("The Matrix (1999)").dedupKey != p("Matrix (1999)").dedupKey)

    println(if (failed == 0) "\nALL PASSED" else "\n$failed FAILED")
    if (failed > 0) System.exit(1)
}
