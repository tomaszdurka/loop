export default function Statistics() {
  const stats = [
    {
      value: "87%",
      label: "Wygranych spraw",
      description: "Klientów uzyskało korzystne wyroki"
    },
    {
      value: "450+",
      label: "Spraw prowadzonych",
      description: "Kredytów frankowych w toku"
    },
    {
      value: "250k PLN",
      label: "Średnie odzyskanie",
      description: "Zwrot nadpłaconych rat"
    },
    {
      value: "18 mies.",
      label: "Średni czas",
      description: "Od pozwu do prawomocnego wyroku"
    }
  ];

  const outcomes = [
    {
      title: "Unieważnienie umowy",
      percentage: 72,
      description: "Kredyt uznany za nieważny od początku"
    },
    {
      title: "Usunięcie klauzul",
      percentage: 15,
      description: "Kredyt przeliczony po kursie NBP"
    },
    {
      title: "Zwrot kosztów",
      percentage: 98,
      description: "Bank pokrywa koszty sądowe i prawne"
    }
  ];

  return (
    <div>
      {/* Main stats */}
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-6 mb-12">
        {stats.map((stat, index) => (
          <div
            key={index}
            className="text-center p-6 rounded-2xl bg-gradient-to-br from-blue-600 to-blue-700 text-white shadow-lg hover:shadow-xl transition-shadow"
          >
            <div className="text-4xl md:text-5xl font-bold mb-2">{stat.value}</div>
            <div className="text-lg font-semibold mb-1">{stat.label}</div>
            <div className="text-sm text-blue-100">{stat.description}</div>
          </div>
        ))}
      </div>

      {/* Detailed outcomes */}
      <div className="bg-white rounded-2xl p-8 md:p-10 shadow-sm border border-slate-200">
        <h3 className="text-2xl font-bold text-slate-900 mb-8 text-center">
          Możliwe rezultaty postępowania
        </h3>
        <div className="space-y-8">
          {outcomes.map((outcome, index) => (
            <div key={index}>
              <div className="flex items-center justify-between mb-2">
                <span className="font-semibold text-slate-900">{outcome.title}</span>
                <span className="text-2xl font-bold text-blue-600">{outcome.percentage}%</span>
              </div>
              <div className="w-full bg-slate-100 rounded-full h-3 mb-2 overflow-hidden">
                <div
                  className="bg-gradient-to-r from-blue-500 to-blue-600 h-3 rounded-full transition-all duration-1000"
                  style={{ width: `${outcome.percentage}%` }}
                ></div>
              </div>
              <p className="text-sm text-slate-600">{outcome.description}</p>
            </div>
          ))}
        </div>
      </div>

      <div className="mt-8 p-6 bg-green-50 border border-green-200 rounded-xl">
        <p className="text-sm text-green-900">
          <strong>✓ Sukces na rynku:</strong> Według danych Rzecznika Finansowego i statystyk
          sądowych, kredyty frankowe są jednymi z najbardziej korzystnych spraw dla konsumentów.
          Polskie sądy konsekwentnie orzekają na korzyść kredytobiorców.
        </p>
      </div>
    </div>
  );
}
